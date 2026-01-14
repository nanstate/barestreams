import { getTitleBasics } from "../imdb/index.js";
import { parseMagnet } from "../parsing/magnet.js";
import type { ParsedStremioId } from "../parsing/stremioId.js";
import { extractQualityHint, formatStreamDisplay } from "../streams/display.js";
import type { Stream, StreamResponse } from "../types.js";
import { fetchJson, fetchText, normalizeBaseUrl } from "./http.js";

type EztvTorrent = {
  title?: string;
  filename?: string;
  torrent_url?: string;
  magnet_url?: string;
  seeds?: number;
  size_bytes?: number;
  season?: number;
  episode?: number;
};

type EztvResponse = {
  torrents?: EztvTorrent[];
  torrents_count?: number;
  limit?: number;
  page?: number;
};

const fetchHtml = (url: string): Promise<string | null> => fetchText(url);

const getImdbDigits = (baseId: string): string => baseId.replace(/^tt/, "");
const DEFAULT_LIMIT = 30;
const MAX_PAGES = 50;

const buildApiUrl = (baseUrl: string, imdbId: string, page: number): string => {
  const normalized = normalizeBaseUrl(baseUrl);
  const url = new URL(`${normalized}/api/get-torrents`);
  url.searchParams.set("imdb_id", imdbId);
  url.searchParams.set("page", String(page));
  return url.toString();
};

const fetchAllTorrents = async (baseUrl: string, imdbId: string): Promise<EztvTorrent[]> => {
  const torrents: EztvTorrent[] = [];
  const firstUrl = buildApiUrl(baseUrl, imdbId, 1);
  const firstResponse = await fetchJson<EztvResponse>(firstUrl);
  if (!firstResponse) {
    return torrents;
  }

  const firstBatch = firstResponse.torrents ?? [];
  torrents.push(...firstBatch);

  let expectedTotal = typeof firstResponse.torrents_count === "number" ? firstResponse.torrents_count : null;
  let pageLimit = typeof firstResponse.limit === "number" && firstResponse.limit > 0 ? firstResponse.limit : DEFAULT_LIMIT;

  if (
    firstBatch.length === 0 ||
    (expectedTotal !== null && torrents.length >= expectedTotal) ||
    firstBatch.length < pageLimit
  ) {
    return torrents;
  }

  const totalPages = expectedTotal ? Math.ceil(expectedTotal / pageLimit) : MAX_PAGES;
  const lastPage = Math.min(totalPages, MAX_PAGES);
  const pageNumbers = Array.from({ length: Math.max(0, lastPage - 1) }, (_, index) => index + 2);
  const concurrency = 5;

  for (let i = 0; i < pageNumbers.length; i += concurrency) {
    const batchPages = pageNumbers.slice(i, i + concurrency);
    const responses = await Promise.all(
      batchPages.map(async (page) => {
        const url = buildApiUrl(baseUrl, imdbId, page);
        return fetchJson<EztvResponse>(url);
      })
    );

    for (const response of responses) {
      const batch = response?.torrents ?? [];
      torrents.push(...batch);
      if (batch.length < pageLimit) {
        break;
      }
    }
    if (expectedTotal !== null && torrents.length >= expectedTotal) {
      break;
    }
  }

  return torrents;
};

const parseEpisodeFromText = (text: string): { season: number; episode: number } | null => {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match =
    normalized.match(/S(?:eason)?\s*0?(\d{1,2})\s*E(?:pisode)?\s*0?(\d{1,2})/i) ??
    normalized.match(/S(\d{1,2})\s*E(\d{1,2})/i) ??
    normalized.match(/(\d{1,2})x(\d{1,2})/i);
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

const formatEpisodeSuffix = (season?: number, episode?: number): string | null => {
  if (!season || !episode) {
    return null;
  }
  const seasonStr = season.toString().padStart(2, "0");
  const episodeStr = episode.toString().padStart(2, "0");
  return `S${seasonStr}E${episodeStr}`;
};

const normalizeTitle = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "into", "over", "under", "a", "an"]);

const tokenizeTitle = (value: string): string[] => {
  const normalized = normalizeTitle(value);
  if (!normalized) {
    return [];
  }
  return normalized
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
};

const compactTitle = (value: string): string => normalizeTitle(value).replace(/\s+/g, "");

const calcTokenOverlap = (haystack: string[], needles: string[]): number => {
  if (needles.length === 0) {
    return 0;
  }
  const haystackSet = new Set(haystack);
  let matches = 0;
  for (const token of needles) {
    if (haystackSet.has(token)) {
      matches += 1;
    }
  }
  return matches / needles.length;
};

const matchesTitleText = (text: string, titles: string[]): boolean => {
  if (titles.length === 0) {
    return true;
  }
  if (!text) {
    return false;
  }
  const normalizedText = normalizeTitle(text);
  if (!normalizedText) {
    return false;
  }

  return titles.some((title) => {
    const normalizedTitle = normalizeTitle(title);
    if (normalizedText.includes(normalizedTitle)) {
      return true;
    }
    const compactText = compactTitle(normalizedText);
    const compactNeedle = compactTitle(normalizedTitle);
    if (compactNeedle && compactText.includes(compactNeedle)) {
      return true;
    }
    const needleTokens = tokenizeTitle(normalizedTitle);
    if (needleTokens.length === 0) {
      return false;
    }
    const overlap = calcTokenOverlap(tokenizeTitle(normalizedText), needleTokens);
    return overlap >= 0.6;
  });
};

const matchesTitle = (torrent: EztvTorrent, titles: string[]): boolean => {
  const text = torrent.title ?? torrent.filename ?? "";
  return matchesTitleText(text, titles);
};

const parseTitleFromSlug = (link: string): string => {
  const pathname = link.startsWith("http") ? new URL(link).pathname : link;
  const cleaned = pathname.replace(/^\//, "").replace(/\/$/, "").replace(/^ep\/\d+\//, "");
  const decoded = decodeURIComponent(cleaned);
  const titlePart = decoded.split(/[/?#]/)[0];
  return titlePart.replace(/-/g, " ");
};

const buildSearchUrl = (baseUrl: string, query: string): string => {
  const normalized = normalizeBaseUrl(baseUrl);
  const encoded = encodeURIComponent(query);
  return `${normalized}/search/${encoded}`;
};

const buildSearchQuery = (baseTitle: string, episodeSuffix: string): string => {
  const normalized = normalizeTitle(baseTitle);
  const mergedPossessives = normalized.replace(/\b(\w+)\s+s\b/g, "$1s");
  return `${mergedPossessives} ${episodeSuffix}`.trim();
};

const extractEpisodeLinks = (html: string, baseUrl: string, limit: number): string[] => {
  const links: string[] = [];
  const seen = new Set<string>();
  const regex = /href="(\/ep\/[^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) && links.length < limit) {
    const href = match[1];
    if (seen.has(href)) {
      continue;
    }
    seen.add(href);
    links.push(new URL(href, baseUrl).toString());
  }
  return links;
};

const extractMagnet = (html: string): string | null => {
  const match = html.match(/href="(magnet:[^"]+)"/i);
  return match ? match[1] : null;
};

const scrapeSearchStreams = async (
  baseUrl: string,
  query: string,
  titleCandidates: string[],
  displayContext: { imdbTitle: string; season?: number; episode?: number }
): Promise<StreamResponse> => {
  const searchUrl = buildSearchUrl(baseUrl, query);
  const html = await fetchHtml(searchUrl);
  if (!html) {
    return { streams: [] };
  }

  const episodeLinks = extractEpisodeLinks(html, baseUrl, 15);
  if (episodeLinks.length === 0) {
    return { streams: [] };
  }

  const results = await Promise.all(
    episodeLinks.map(async (link) => {
      const pageHtml = await fetchHtml(link);
      if (!pageHtml) {
        return null;
      }
      const magnet = extractMagnet(pageHtml);
      if (!magnet) {
        return null;
      }
      const parsedMagnet = parseMagnet(magnet);
      if (!parsedMagnet) {
        return null;
      }
      const title = parseTitleFromSlug(link);
      if (!matchesTitleText(title, titleCandidates)) {
        return null;
      }
      const quality = extractQualityHint(title);
      const display = formatStreamDisplay({
        addonPrefix: "LT",
        imdbTitle: displayContext.imdbTitle,
        season: displayContext.season,
        episode: displayContext.episode,
        torrentName: title,
        quality
      });
      return {
        name: display.name,
        title: display.title,
        description: display.description,
        infoHash: parsedMagnet.infoHash,
        sources: parsedMagnet.sources
      };
    })
  );

  const streams = results.filter((stream): stream is NonNullable<typeof stream> => Boolean(stream));
  return { streams };
};

const matchesEpisode = (torrent: EztvTorrent, season?: number, episode?: number): boolean => {
  if (!season || !episode) {
    return true;
  }

  const torrentSeason = Number(torrent.season);
  const torrentEpisode = Number(torrent.episode);
  if (torrentSeason > 0 && torrentEpisode > 0) {
    return torrentSeason === season && torrentEpisode === episode;
  }

  const text = torrent.title ?? torrent.filename ?? "";
  const parsed = text ? parseEpisodeFromText(text) : null;
  if (!parsed) {
    return false;
  }
  return parsed.season === season && parsed.episode === episode;
};

const buildBehaviorHints = (torrent: EztvTorrent): Stream["behaviorHints"] | undefined => {
  const hints: Stream["behaviorHints"] = {};
  if (typeof torrent.size_bytes === "number" && torrent.size_bytes > 0) {
    hints.videoSize = torrent.size_bytes;
  }
  if (torrent.filename) {
    hints.filename = torrent.filename;
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
};

const sortBySeedsDesc = (a: EztvTorrent, b: EztvTorrent): number => {
  const aSeeds = typeof a.seeds === "number" ? a.seeds : 0;
  const bSeeds = typeof b.seeds === "number" ? b.seeds : 0;
  return bSeeds - aSeeds;
};

export const scrapeEztvStreams = async (
  parsed: ParsedStremioId,
  eztvUrls: string[]
): Promise<StreamResponse> => {
  const imdbDigits = getImdbDigits(parsed.baseId);
  const basics = await getTitleBasics(parsed.baseId);
  const titleCandidates = [basics?.primaryTitle, basics?.originalTitle]
    .filter((title): title is string => Boolean(title))
    .map((title) => normalizeTitle(title))
    .filter((title, index, all) => all.indexOf(title) === index);

  const responses = await Promise.allSettled(
    eztvUrls.flatMap((baseUrl) => {
      const imdbIds = [imdbDigits, `tt${imdbDigits}`];
      return imdbIds.map((imdbId) => fetchAllTorrents(baseUrl, imdbId));
    })
  );

  const torrents = responses.flatMap((result) => {
    if (result.status !== "fulfilled") {
      return [];
    }
    return result.value;
  });

  const seen = new Set<string>();
  const streams = torrents
    .slice()
    .sort(sortBySeedsDesc)
    .filter((torrent) => matchesTitle(torrent, titleCandidates))
    .filter((torrent) => matchesEpisode(torrent, parsed.season, parsed.episode))
    .map((torrent) => {
      const magnet = torrent.magnet_url;
      if (!magnet) {
        return null;
      }
      const parsedMagnet = parseMagnet(magnet);
      if (!parsedMagnet) {
        return null;
      }
      if (seen.has(parsedMagnet.infoHash)) {
        return null;
      }
      seen.add(parsedMagnet.infoHash);
      const torrentName = torrent.title ?? torrent.filename ?? "EZTV";
      const imdbTitle = basics?.primaryTitle || basics?.originalTitle || "EZTV";
      const quality = extractQualityHint(torrentName);
      const display = formatStreamDisplay({
        addonPrefix: "LT",
        imdbTitle,
        season: parsed.season,
        episode: parsed.episode,
        torrentName,
        quality,
        seeders: torrent.seeds,
        sizeBytes: torrent.size_bytes
      });
      return {
        name: display.name,
        title: display.title,
        description: display.description,
        infoHash: parsedMagnet.infoHash,
        sources: parsedMagnet.sources,
        behaviorHints: buildBehaviorHints(torrent),
        seeders: torrent.seeds
      };
    })
    .filter((stream): stream is NonNullable<typeof stream> => Boolean(stream));

  let fallbackStreams: StreamResponse | null = null;
  if (streams.length === 0 && parsed.season && parsed.episode && titleCandidates.length > 0) {
    const episodeSuffix = formatEpisodeSuffix(parsed.season, parsed.episode);
    const baseTitle = basics?.primaryTitle || basics?.originalTitle;
    if (episodeSuffix && baseTitle) {
      const query = buildSearchQuery(baseTitle, episodeSuffix);
      const imdbTitle = basics?.primaryTitle || basics?.originalTitle || baseTitle;
      const fallbackResults = await Promise.allSettled(
        eztvUrls.map((baseUrl) =>
          scrapeSearchStreams(baseUrl, query, titleCandidates, {
            imdbTitle,
            season: parsed.season,
            episode: parsed.episode
          })
        )
      );
      const fallbackList = fallbackResults.flatMap((result) =>
        result.status === "fulfilled" ? result.value.streams : []
      );
      const fallbackSeen = new Set<string>();
      const deduped = fallbackList.filter((stream) => {
        const key = stream.infoHash ?? stream.url ?? "";
        if (!key || fallbackSeen.has(key)) {
          return false;
        }
        fallbackSeen.add(key);
        return true;
      });
      fallbackStreams = { streams: deduped };
    }
  }

  if (fallbackStreams && fallbackStreams.streams.length > 0) {
    return fallbackStreams;
  }

  return { streams };
};
