import { load } from "cheerio";
import type { ParsedStremioId } from "../parsing/stremioId.js";
import { parseMagnet } from "../parsing/magnet.js";
import { extractQualityHint } from "../streams/quality.js";
import { formatStreamDisplay } from "../streams/display.js";
import type { Stream, StreamResponse } from "../types.js";
import { fetchText, normalizeBaseUrl } from "./http.js";
import { buildQueries, matchesEpisode, normalizeQuery } from "./query.js";

type X1337xLink = {
  name: string;
  url: string;
  seeders: number;
  leechers: number;
  size: string;
};

type X1337xDetails = {
  magnetURI?: string;
};

const fetchHtml = (url: string): Promise<string | null> => fetchText(url, { useFlareSolverr: true });

const buildSearchUrl = (baseUrl: string, query: string, page: number): string => {
  const normalized = normalizeBaseUrl(baseUrl);
  const encoded = encodeURIComponent(query);
  return `${normalized}/search/${encoded}/${page}/`;
};

const parseNumber = (value: string): number => {
  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

const extractSizeLabel = (value: string): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  const match = normalized.match(/(\d+(?:\.\d+)?\s*(?:KB|MB|GB|TB|KiB|MiB|GiB|TiB))/i);
  return match ? match[1] : normalized;
};

const parseSearchResults = (html: string, baseUrl: string, limit: number): X1337xLink[] => {
  const $ = load(html);
  const results: X1337xLink[] = [];
  const rows = $(".table-list tbody tr");
  rows.each((_, element) => {
    if (results.length >= limit) {
      return;
    }
    const anchor = $(element).find("td.name a[href^='/torrent/']").first();
    const name = anchor.text().trim();
    const href = anchor.attr("href");
    if (!href || !name) {
      return;
    }
    const url = new URL(href, baseUrl).toString();
    const seedersText = $(element).find("td.seeds, td.coll-2").first().text();
    const leechersText = $(element).find("td.leeches, td.coll-3").first().text();
    const sizeText = $(element).find("td.size, td.coll-4").first().text();
    const size = extractSizeLabel(sizeText);
    results.push({
      name,
      url,
      seeders: parseNumber(seedersText),
      leechers: parseNumber(leechersText),
      size
    });
  });
  return results;
};

const searchX1337x = async (baseUrl: string, query: string, limit: number): Promise<X1337xLink[]> => {
  const results: X1337xLink[] = [];
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

const fetchTorrentDetails = async (url: string): Promise<X1337xDetails | null> => {
  const html = await fetchHtml(url);
  if (!html) {
    return null;
  }
  const $ = load(html);
  const magnetURI =
    $("a[href^='magnet:?']").attr("href") ?? $("a[href^='magnet:']").attr("href") ?? undefined;
  return { magnetURI };
};

const parseSizeToBytes = (rawSize: string): number | null => {
  const match = rawSize.trim().match(/([\d.]+)\s*(B|KB|MB|GB|TB|KIB|MIB|GIB|TIB)/i);
  if (!match) {
    return null;
  }
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) {
    return null;
  }
  const unit = match[2].toUpperCase();
  const base = unit.endsWith("IB") ? 1024 : 1024;
  const multipliers: Record<string, number> = {
    B: 1,
    KB: base,
    MB: base ** 2,
    GB: base ** 3,
    TB: base ** 4,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4
  };
  const multiplier = multipliers[unit];
  if (!multiplier) {
    return null;
  }
  return Math.round(value * multiplier);
};

const extractFilename = (name: string): string | undefined => {
  const match = name.match(/\b([^\s/\\]+?\.(?:mkv|mp4|avi|ts|m4v))\b/i);
  return match?.[1];
};

const buildBehaviorHints = (link: X1337xLink): Stream["behaviorHints"] | undefined => {
  const hints: Stream["behaviorHints"] = {};
  const sizeBytes = link.size ? parseSizeToBytes(link.size) : null;
  if (sizeBytes && sizeBytes > 0) {
    hints.videoSize = sizeBytes;
  }
  const filename = extractFilename(link.name);
  if (filename) {
    hints.filename = filename;
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
};

const dedupeLinks = (links: X1337xLink[]): X1337xLink[] => {
  const seen = new Set<string>();
  const results: X1337xLink[] = [];
  for (const link of links) {
    if (seen.has(link.url)) {
      continue;
    }
    seen.add(link.url);
    results.push(link);
  }
  return results;
};

const sortBySeedersDesc = (a: X1337xLink, b: X1337xLink): number => b.seeders - a.seeders;

export const scrapeX1337xStreams = async (
  parsed: ParsedStremioId,
  baseUrls: string[]
): Promise<StreamResponse> => {
  const { baseTitle, query, episodeSuffix } = await buildQueries(parsed);
  const links: X1337xLink[] = [];

  for (const baseUrl of baseUrls) {
    if (links.length >= 20) {
      break;
    }
    const batch = await searchX1337x(baseUrl, query, 20 - links.length);
    links.push(...batch);
  }

  let filteredLinks = links;
  if (links.length === 0 && episodeSuffix) {
    for (const baseUrl of baseUrls) {
      if (filteredLinks.length >= 20) {
        break;
      }
      const fallbackQuery = normalizeQuery(baseTitle);
      const batch = await searchX1337x(baseUrl, fallbackQuery, 20 - filteredLinks.length);
      filteredLinks.push(...batch);
    }
  }

  if (episodeSuffix) {
    filteredLinks = filteredLinks.filter((link) => matchesEpisode(link.name, parsed.season, parsed.episode));
  }

  const uniqueLinks = dedupeLinks(filteredLinks);
  const sortedLinks = uniqueLinks.slice().sort(sortBySeedersDesc);
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
      if (!details?.magnetURI) {
        return null;
      }
      const parsedMagnet = parseMagnet(details.magnetURI);
      if (!parsedMagnet) {
        return null;
      }
      const quality = extractQualityHint(link.name ?? "");
      const sizeBytes = link.size ? parseSizeToBytes(link.size) : null;
      const display = formatStreamDisplay({
        imdbTitle: baseTitle,
        season: parsed.season,
        episode: parsed.episode,
        torrentName: link.name,
        quality,
        source: "1337x",
        seeders: link.seeders,
        sizeBytes,
        sizeLabel: link.size
      });
      return {
        name: display.name,
        title: display.title,
        description: display.description,
        infoHash: parsedMagnet.infoHash,
        sources: parsedMagnet.sources,
        behaviorHints: buildBehaviorHints(link),
        seeders: link.seeders
      };
    })
    .filter((stream): stream is NonNullable<typeof stream> => Boolean(stream));

  return { streams };
};
