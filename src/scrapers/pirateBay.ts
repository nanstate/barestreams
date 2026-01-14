import type { ParsedStremioId } from "../parsing/stremioId.js";
import { getTitleBasics } from "../imdb/index.js";
import { parseMagnet } from "../parsing/magnet.js";
import { extractQualityHint, formatStreamDisplay } from "../streams/display.js";
import type { Stream, StreamResponse } from "../types.js";
import { fetchJson, normalizeBaseUrl } from "./http.js";

type PirateBayResult = {
  title?: string;
  magnet?: string;
  sizeBytes?: number;
  seeders: number;
  leechers: number;
};

type PirateBayApiResult = {
  id?: string;
  name?: string;
  info_hash?: string;
  seeders?: string | number;
  leechers?: string | number;
  size?: string | number;
};

const MOVIE_CATEGORIES = [207, 201];
const SERIES_CATEGORIES = [208, 205];

const API_BASE_FALLBACK = "https://apibay.org";

const resolveApiBase = (baseUrl: string): string => {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    const url = new URL(normalized);
    if (url.hostname.includes("apibay.org")) {
      return normalized;
    }
  } catch {
    // Fall through to default API base.
  }
  return API_BASE_FALLBACK;
};

const buildSearchUrl = (apiBase: string, query: string, category: number): string => {
  const normalized = normalizeBaseUrl(apiBase);
  const params = new URLSearchParams({ q: query, cat: category.toString() });
  return `${normalized}/q.php?${params.toString()}`;
};

const parseSizeToBytes = (rawSize?: string | number): number | null => {
  if (rawSize === undefined || rawSize === null) {
    return null;
  }
  const value = typeof rawSize === "string" ? Number.parseFloat(rawSize) : rawSize;
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.round(value);
};

const extractFilename = (name?: string): string | undefined => {
  if (!name) {
    return undefined;
  }
  const match = name.match(/\b([^\s/\\]+?\.(?:mkv|mp4|avi|ts|m4v))\b/i);
  return match?.[1];
};

const buildBehaviorHints = (result: PirateBayResult): Stream["behaviorHints"] | undefined => {
  const hints: Stream["behaviorHints"] = {};
  if (result.sizeBytes && result.sizeBytes > 0) {
    hints.videoSize = result.sizeBytes;
  }
  const filename = extractFilename(result.title);
  if (filename) {
    hints.filename = filename;
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
};

const parseSearchResults = (payload: PirateBayApiResult[], limit: number): PirateBayResult[] => {
  const results: PirateBayResult[] = [];
  for (const entry of payload) {
    if (results.length >= limit) {
      break;
    }
    const title = entry.name?.trim() || undefined;
    const infoHash = entry.info_hash?.trim();
    const magnet = infoHash ? `magnet:?xt=urn:btih:${infoHash}` : undefined;
    const sizeBytes = parseSizeToBytes(entry.size);
    const seeders = Number(entry.seeders);
    const leechers = Number(entry.leechers);
    results.push({
      title,
      magnet,
      sizeBytes: sizeBytes ?? undefined,
      seeders: Number.isFinite(seeders) ? seeders : 0,
      leechers: Number.isFinite(leechers) ? leechers : 0
    });
  }
  return results;
};

const isSeriesTitleType = (titleType?: string): boolean => {
  if (!titleType) {
    return false;
  }
  const normalized = titleType.toLowerCase();
  return normalized === "tvseries" || normalized === "tvminiseries" || normalized === "tvepisode";
};

const normalizeQuery = (value: string): string => {
  return value
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const formatEpisodeSuffix = (season?: number, episode?: number): string | null => {
  if (!season || !episode) {
    return null;
  }
  const seasonStr = season.toString().padStart(2, "0");
  const episodeStr = episode.toString().padStart(2, "0");
  return `S${seasonStr}E${episodeStr}`;
};

const buildQueries = async (
  parsed: ParsedStremioId
): Promise<{ baseTitle: string; query: string; episodeSuffix: string | null }> => {
  const basics = await getTitleBasics(parsed.baseId);
  const baseTitle = basics?.primaryTitle || basics?.originalTitle || parsed.baseId;
  const episodeSuffix = formatEpisodeSuffix(parsed.season, parsed.episode);
  const isSeries = isSeriesTitleType(basics?.titleType) || Boolean(episodeSuffix);

  if (isSeries && episodeSuffix) {
    return { baseTitle, query: normalizeQuery(`${baseTitle} ${episodeSuffix}`), episodeSuffix };
  }
  return { baseTitle, query: normalizeQuery(baseTitle), episodeSuffix: null };
};

const parseEpisodeFromText = (text?: string): { season: number; episode: number } | null => {
  if (!text) {
    return null;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = normalized.match(/S(\d{1,2})E(\d{1,2})/i) ?? normalized.match(/(\d{1,2})x(\d{1,2})/i);
  if (!match) {
    return null;
  }
  const season = Number(match[1]);
  const episode = Number(match[2]);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) {
    return null;
  }
  return { season, episode };
};

const matchesEpisode = (name: string | undefined, season?: number, episode?: number): boolean => {
  if (!season || !episode) {
    return true;
  }
  const parsed = parseEpisodeFromText(name);
  if (!parsed) {
    return false;
  }
  return parsed.season === season && parsed.episode === episode;
};

const dedupeResults = (results: PirateBayResult[]): PirateBayResult[] => {
  const seen = new Set<string>();
  const deduped: PirateBayResult[] = [];
  for (const result of results) {
    const key = result.magnet || result.title || "";
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
};

export const scrapePirateBayStreams = async (
  parsed: ParsedStremioId,
  pirateBayUrls: string[],
  type: "movie" | "series"
): Promise<StreamResponse> => {
  const { baseTitle, query, episodeSuffix } = await buildQueries(parsed);
  const categories = type === "movie" ? MOVIE_CATEGORIES : SERIES_CATEGORIES;
  const results: PirateBayResult[] = [];

  for (const baseUrl of pirateBayUrls) {
    if (results.length >= 20) {
      break;
    }
    for (const category of categories) {
      if (results.length >= 20) {
        break;
      }
      const apiBase = resolveApiBase(baseUrl);
      const payload = await fetchJson<PirateBayApiResult[]>(
        buildSearchUrl(apiBase, query, category)
      );
      if (!payload || !Array.isArray(payload)) {
        continue;
      }
      results.push(...parseSearchResults(payload, 20 - results.length));
    }
  }

  let filtered = results;
  if (results.length === 0 && episodeSuffix) {
    for (const baseUrl of pirateBayUrls) {
      if (filtered.length >= 20) {
        break;
      }
      for (const category of categories) {
        if (filtered.length >= 20) {
          break;
        }
        const fallbackQuery = normalizeQuery(baseTitle);
        const apiBase = resolveApiBase(baseUrl);
        const payload = await fetchJson<PirateBayApiResult[]>(
          buildSearchUrl(apiBase, fallbackQuery, category)
        );
        if (!payload || !Array.isArray(payload)) {
          continue;
        }
        filtered.push(...parseSearchResults(payload, 20 - filtered.length));
      }
    }
  }

  if (episodeSuffix) {
    filtered = filtered.filter((result) => matchesEpisode(result.title, parsed.season, parsed.episode));
  }

  const uniqueResults = dedupeResults(filtered);
  const streams = uniqueResults
    .map((result) => {
      if (!result.magnet) {
        return null;
      }
      const parsedMagnet = parseMagnet(result.magnet);
      if (!parsedMagnet) {
        return null;
      }
      const quality = extractQualityHint(result.title ?? "");
      const sizeBytes = result.sizeBytes ?? null;
      const display = formatStreamDisplay({
        imdbTitle: baseTitle,
        season: parsed.season,
        episode: parsed.episode,
        torrentName: result.title,
        quality,
        source: "TPB",
        seeders: result.seeders,
        sizeBytes,
        sizeLabel: null
      });
      return {
        name: display.name,
        title: display.title,
        description: display.description,
        infoHash: parsedMagnet.infoHash,
        sources: parsedMagnet.sources,
        behaviorHints: buildBehaviorHints(result),
        seeders: result.seeders
      };
    })
    .filter((stream): stream is NonNullable<typeof stream> => Boolean(stream));

  return { streams };
};
