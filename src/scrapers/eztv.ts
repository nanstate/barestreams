import { getTitleBasics } from "../imdb/index.js";
import type { ParsedStremioId } from "../parsing/stremioId.js";
import type { StreamResponse } from "../types.js";

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

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");
const DEBUG = process.env.DEBUG_EZTV === "1";

const fetchHtml = async (url: string): Promise<string | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "lazy-torrentio" },
      signal: controller.signal
    });
    if (!response.ok) {
      if (DEBUG) {
        console.warn(`[EZTV] ${response.status} ${response.statusText} for ${url}`);
      }
      return null;
    }
    return await response.text();
  } catch (err) {
    if (DEBUG) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[EZTV] fetch failed for ${url}: ${message}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const fetchJson = async (url: string): Promise<EztvResponse | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "lazy-torrentio" },
      signal: controller.signal
    });
    if (!response.ok) {
      if (DEBUG) {
        console.warn(`[EZTV] ${response.status} ${response.statusText} for ${url}`);
      }
      return null;
    }
    const data = (await response.json()) as EztvResponse;
    if (DEBUG) {
      const count = data.torrents?.length ?? 0;
      const total = data.torrents_count ?? "n/a";
      const page = data.page ?? "n/a";
      const limit = data.limit ?? "n/a";
      console.warn(`[EZTV] ${url} returned ${count} torrents (page=${page} limit=${limit} total=${total})`);
    }
    return data;
  } catch (err) {
    if (DEBUG) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[EZTV] fetch failed for ${url}: ${message}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

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
  if (DEBUG) {
    console.warn(`[EZTV] fetching ${firstUrl}`);
  }
  const firstResponse = await fetchJson(firstUrl);
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
    if (DEBUG) {
      console.warn("[EZTV] fetched only page 1");
    }
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
        if (DEBUG) {
          console.warn(`[EZTV] fetching ${url}`);
        }
        return fetchJson(url);
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

  if (DEBUG) {
    console.warn(`[EZTV] fetched ${torrents.length} torrents across ${lastPage} page(s)`);
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
  titleCandidates: string[]
): Promise<StreamResponse> => {
  const searchUrl = buildSearchUrl(baseUrl, query);
  if (DEBUG) {
    console.warn(`[EZTV] search ${searchUrl}`);
  }
  const html = await fetchHtml(searchUrl);
  if (!html) {
    return { streams: [] };
  }

  const episodeLinks = extractEpisodeLinks(html, baseUrl, 15);
  if (DEBUG) {
    console.warn(`[EZTV] search links ${episodeLinks.length}`);
  }
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
      const title = parseTitleFromSlug(link);
      if (!matchesTitleText(title, titleCandidates)) {
        return null;
      }
      return { name: "EZTV", title, url: magnet };
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

const formatTitle = (torrent: EztvTorrent): string => {
  const baseTitle = torrent.title ?? torrent.filename ?? "EZTV";
  if (!torrent.seeds && !torrent.size_bytes) {
    return baseTitle;
  }

  const parts: string[] = [];
  if (torrent.seeds) {
    parts.push(`S:${torrent.seeds}`);
  }
  if (torrent.size_bytes) {
    const sizeGiB = torrent.size_bytes / (1024 * 1024 * 1024);
    parts.push(`${sizeGiB.toFixed(2)} GiB`);
  }
  return `${baseTitle} (${parts.join(" • ")})`;
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

  if (DEBUG) {
    console.warn(`[EZTV] imdb=${imdbDigits} season=${parsed.season ?? "n/a"} episode=${parsed.episode ?? "n/a"}`);
    if (titleCandidates.length > 0) {
      console.warn(`[EZTV] title filter=${titleCandidates.join(" | ")}`);
    }
  }
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
    .filter((torrent) => matchesTitle(torrent, titleCandidates))
    .filter((torrent) => matchesEpisode(torrent, parsed.season, parsed.episode))
    .map((torrent) => {
      const url = torrent.magnet_url ?? torrent.torrent_url;
      if (!url) {
        return null;
      }
      if (seen.has(url)) {
        return null;
      }
      seen.add(url);
      return {
        name: "EZTV",
        title: formatTitle(torrent),
        url
      };
    })
    .filter((stream): stream is NonNullable<typeof stream> => Boolean(stream));

  let fallbackStreams: StreamResponse | null = null;
  if (streams.length === 0 && parsed.season && parsed.episode && titleCandidates.length > 0) {
    const episodeSuffix = formatEpisodeSuffix(parsed.season, parsed.episode);
    const baseTitle = basics?.primaryTitle || basics?.originalTitle;
    if (episodeSuffix && baseTitle) {
      const query = buildSearchQuery(baseTitle, episodeSuffix);
      const fallbackResults = await Promise.allSettled(
        eztvUrls.map((baseUrl) => scrapeSearchStreams(baseUrl, query, titleCandidates))
      );
      const fallbackList = fallbackResults.flatMap((result) =>
        result.status === "fulfilled" ? result.value.streams : []
      );
      const fallbackSeen = new Set<string>();
      const deduped = fallbackList.filter((stream) => {
        if (fallbackSeen.has(stream.url)) {
          return false;
        }
        fallbackSeen.add(stream.url);
        return true;
      });
      fallbackStreams = { streams: deduped };
    }
  }

  if (fallbackStreams && fallbackStreams.streams.length > 0) {
    if (DEBUG) {
      console.warn(`[EZTV] search fallback streams ${fallbackStreams.streams.length}`);
    }
    return fallbackStreams;
  }

  if (DEBUG) {
    console.warn(`[EZTV] ${streams.length} streams after filtering`);
    if (streams.length === 0 && torrents.length > 0) {
      const sample = torrents.slice(0, 5).map((torrent) => ({
        title: torrent.title ?? torrent.filename ?? "n/a",
        season: torrent.season,
        episode: torrent.episode
      }));
      console.warn("[EZTV] sample torrents:", sample);
      const seasonHints = torrents
        .filter((torrent) => {
          const title = (torrent.title ?? torrent.filename ?? "").toLowerCase();
          return title.includes("s02") || title.includes("season 2") || title.includes(" 2x");
        })
        .slice(0, 5)
        .map((torrent) => ({
          title: torrent.title ?? torrent.filename ?? "n/a",
          season: torrent.season,
          episode: torrent.episode
        }));
      if (seasonHints.length > 0) {
        console.warn("[EZTV] season-2-ish torrents:", seasonHints);
      }
    }
  }
  return { streams };
};
