import type { ParsedStremioId } from "../parsing/stremioId.js";
import type { StreamResponse } from "../types.js";

type YtsTorrent = {
  hash: string;
  quality: string;
  type: string;
  seeds: number;
  size_bytes: number;
};

type YtsMovie = {
  imdb_code: string;
  title: string;
  title_long: string;
  torrents?: YtsTorrent[];
};

type YtsResponse = {
  status: string;
  data?: {
    movies?: YtsMovie[];
  };
};

const TRACKERS = [
  "udp://open.stealth.si:80/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://9.rarbg.to:2930/announce"
];

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

const ensureApiRoot = (baseUrl: string): string =>
  baseUrl.includes("/api/") ? baseUrl : `${baseUrl}/api/v2`;

const fetchJson = async (url: string): Promise<YtsResponse | null> => {
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
    return (await response.json()) as YtsResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const buildListUrl = (baseUrl: string, imdbId: string): string => {
  const normalized = normalizeBaseUrl(baseUrl);
  const apiRoot = ensureApiRoot(normalized);
  const params = new URLSearchParams({ query_term: imdbId, limit: "1" });
  return `${apiRoot}/list_movies.json?${params.toString()}`;
};

const formatTitle = (movie: YtsMovie, torrent: YtsTorrent): string => {
  const baseTitle = movie.title_long || movie.title || "YTS";
  const sizeGiB = torrent.size_bytes ? torrent.size_bytes / (1024 * 1024 * 1024) : 0;
  const parts = [`${torrent.quality} ${torrent.type}`];
  if (torrent.seeds) {
    parts.push(`S:${torrent.seeds}`);
  }
  if (sizeGiB) {
    parts.push(`${sizeGiB.toFixed(2)} GiB`);
  }
  return `${baseTitle} (${parts.join(" • ")})`;
};

const buildMagnet = (hash: string, name: string): string => {
  const trackers = TRACKERS.map((tracker) => `&tr=${encodeURIComponent(tracker)}`).join("");
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${trackers}`;
};

export const scrapeYtsStreams = async (
  parsed: ParsedStremioId,
  ytsUrls: string[]
): Promise<StreamResponse> => {
  const imdbId = parsed.baseId;
  const responses = await Promise.allSettled(
    ytsUrls.map((baseUrl) => fetchJson(buildListUrl(baseUrl, imdbId)))
  );

  const movies = responses.flatMap((result) => {
    if (result.status !== "fulfilled") {
      return [];
    }
    const response = result.value;
    return response?.data?.movies ?? [];
  });

  const matchingMovies = movies.filter((movie) => movie.imdb_code === imdbId);

  const seen = new Set<string>();
  const streams = matchingMovies
    .flatMap((movie) =>
      (movie.torrents ?? []).map((torrent) => ({ movie, torrent }))
    )
    .map(({ movie, torrent }) => {
      const key = torrent.hash;
      if (!torrent.hash || seen.has(key)) {
        return null;
      }
      seen.add(key);
      const displayName = `${movie.title_long || movie.title} ${torrent.quality} ${torrent.type}`;
      return {
        name: "YTS",
        title: formatTitle(movie, torrent),
        url: buildMagnet(torrent.hash, displayName)
      };
    })
    .filter((stream): stream is NonNullable<typeof stream> => Boolean(stream));

  return { streams };
};
