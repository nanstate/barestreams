import { load } from "cheerio";
import type { ParsedStremioId } from "../parsing/stremioId.js";
import { getTitleBasics } from "../imdb/index.js";
import { parseMagnet } from "../parsing/magnet.js";
import type { StreamResponse } from "../types.js";

type TorrentGalaxyLink = {
  name: string;
  url: string;
  seeders: number;
  leechers: number;
  size: string;
};

type TorrentGalaxyDetails = {
  magnetURI?: string;
  torrentDownload?: string;
};

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");
const DEBUG = process.env.DEBUG_TGX === "1";

const fetchHtml = async (url: string): Promise<string | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "lazy-torrentio" },
      signal: controller.signal
    });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const buildSearchUrl = (baseUrl: string, query: string, page: number): string => {
  const normalized = normalizeBaseUrl(baseUrl);
  const params = new URLSearchParams({
    q: query,
    category: "lmsearch",
    page: page.toString()
  });
  return `${normalized}/lmsearch?${params.toString()}`;
};

const parseSearchResults = (html: string, baseUrl: string, limit: number): TorrentGalaxyLink[] => {
  const $ = load(html);
  const results: TorrentGalaxyLink[] = [];
  const rows = $(".table-list-wrap tbody tr");
  rows.each((_, element) => {
    if (results.length >= limit) {
      return;
    }
    const anchor = $(element).find("td .tt-name a").eq(0);
    const name = anchor.text().trim();
    const href = anchor.attr("href");
    if (!href) {
      return;
    }
    const url = new URL(href, baseUrl).toString();
    const tds = $(element).find("td");
    const size = $(tds[2]).text().trim();
    const seeders = Number($(tds[3]).text().trim().replace(/,/g, ""));
    const leechers = Number($(tds[4]).text().trim().replace(/,/g, ""));
    results.push({
      name,
      url,
      seeders: Number.isFinite(seeders) ? seeders : 0,
      leechers: Number.isFinite(leechers) ? leechers : 0,
      size
    });
  });
  return results;
};

const searchTorrentGalaxy = async (
  baseUrl: string,
  query: string,
  limit: number
): Promise<TorrentGalaxyLink[]> => {
  const results: TorrentGalaxyLink[] = [];
  const normalizedBase = normalizeBaseUrl(baseUrl);
  let page = 1;
  while (results.length < limit) {
    const html = await fetchHtml(buildSearchUrl(normalizedBase, query, page));
    if (!html) {
      break;
    }
    const batch = parseSearchResults(html, normalizedBase, limit - results.length);
    if (batch.length === 0) {
      break;
    }
    results.push(...batch);
    page += 1;
  }
  return results;
};

const fetchTorrentDetails = async (url: string): Promise<TorrentGalaxyDetails | null> => {
  const html = await fetchHtml(url);
  if (!html) {
    return null;
  }
  const $ = load(html);
  const magnetURI = $("a[href^='magnet:?']").attr("href") ?? undefined;
  const torrentDownload = $("a[href$='.torrent']").attr("href");
  const resolvedDownload = torrentDownload ? new URL(torrentDownload, url).toString() : undefined;
  return { magnetURI, torrentDownload: resolvedDownload };
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

const formatTitle = (link: TorrentGalaxyLink): string => {
  const baseTitle = link.name || "TGx";
  const parts: string[] = [];
  if (link.seeders) {
    parts.push(`S:${link.seeders}`);
  }
  if (link.leechers) {
    parts.push(`L:${link.leechers}`);
  }
  if (link.size) {
    parts.push(link.size);
  }
  if (parts.length === 0) {
    return baseTitle;
  }
  return `${baseTitle} (${parts.join(" • ")})`;
};

const dedupeLinks = (links: TorrentGalaxyLink[]): TorrentGalaxyLink[] => {
  const seen = new Set<string>();
  const results: TorrentGalaxyLink[] = [];
  for (const link of links) {
    if (seen.has(link.url)) {
      continue;
    }
    seen.add(link.url);
    results.push(link);
  }
  return results;
};

const sortBySeedersDesc = (a: TorrentGalaxyLink, b: TorrentGalaxyLink): number => b.seeders - a.seeders;

const parseEpisodeFromText = (text: string): { season: number; episode: number } | null => {
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

const matchesEpisode = (name: string, season?: number, episode?: number): boolean => {
  if (!season || !episode) {
    return true;
  }
  const parsed = parseEpisodeFromText(name);
  if (!parsed) {
    return false;
  }
  return parsed.season === season && parsed.episode === episode;
};

export const scrapeTorrentGalaxyStreams = async (
  parsed: ParsedStremioId,
  tgxUrls: string[]
): Promise<StreamResponse> => {
  const { baseTitle, query, episodeSuffix } = await buildQueries(parsed);
  const links: TorrentGalaxyLink[] = [];

  for (const baseUrl of tgxUrls) {
    if (links.length >= 20) {
      break;
    }
    if (DEBUG) {
      console.warn(`[TGx] searching ${baseUrl} query="${query}"`);
    }
    const batch = await searchTorrentGalaxy(baseUrl, query, 20 - links.length);
    links.push(...batch);
  }

  let filteredLinks = links;
  if (links.length === 0 && episodeSuffix) {
    for (const baseUrl of tgxUrls) {
      if (filteredLinks.length >= 20) {
        break;
      }
      const fallbackQuery = normalizeQuery(baseTitle);
      if (DEBUG) {
        console.warn(`[TGx] fallback search ${baseUrl} query="${fallbackQuery}"`);
      }
      const batch = await searchTorrentGalaxy(baseUrl, fallbackQuery, 20 - filteredLinks.length);
      filteredLinks.push(...batch);
    }
  }

  if (episodeSuffix) {
    filteredLinks = filteredLinks.filter((link) => matchesEpisode(link.name, parsed.season, parsed.episode));
  }

  const uniqueLinks = dedupeLinks(filteredLinks);
  const sortedLinks = uniqueLinks.slice().sort(sortBySeedersDesc);
  if (DEBUG) {
    console.warn(`[TGx] ${sortedLinks.length} links after filtering`);
  }
  const detailResults = await Promise.allSettled(
    sortedLinks.map((link) => fetchTorrentDetails(link.url))
  );

  const streams = sortedLinks
    .map((link, index) => {
      const detailResult = detailResults[index];
      if (detailResult.status !== "fulfilled") {
        return null;
      }
      const details = detailResult.value;
      if (!details) {
        return null;
      }
      const magnet = details.magnetURI;
      if (!magnet) {
        return null;
      }
      const parsedMagnet = parseMagnet(magnet);
      if (!parsedMagnet) {
        return null;
      }
      return {
        name: "TGx",
        title: link.name,
        description: formatTitle(link),
        infoHash: parsedMagnet.infoHash,
        sources: parsedMagnet.sources.length ? parsedMagnet.sources : undefined,
        seeders: link.seeders
      };
    })
    .filter((stream): stream is NonNullable<typeof stream> => Boolean(stream));

  return { streams };
};
