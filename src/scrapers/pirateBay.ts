import type { ParsedStremioId } from "../parsing/stremioId.js";
import { parseMagnet } from "../parsing/magnet.js";
import { extractQualityHint } from "../streams/quality.js";
import { formatStreamDisplay } from "../streams/display.js";
import type { Stream, StreamResponse } from "../types.js";
import { fetchJson, normalizeBaseUrl } from "./http.js";
import { buildQueries, matchesEpisode, normalizeQuery } from "./query.js";

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
