import type { ParsedStremioId } from "../parsing/stremioId.js";
import { formatStreamDisplay } from "../streams/display.js";
import { fetchJson, normalizeBaseUrl } from "./http.js";
import type { Stream, StreamResponse } from "../types.js";

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

const ensureApiRoot = (baseUrl: string): string =>
  baseUrl.includes("/api/") ? baseUrl : `${baseUrl}/api/v2`;

const buildListUrl = (baseUrl: string, imdbId: string): string => {
  const normalized = normalizeBaseUrl(baseUrl);
  const apiRoot = ensureApiRoot(normalized);
  const params = new URLSearchParams({ query_term: imdbId, limit: "1" });
  return `${apiRoot}/list_movies.json?${params.toString()}`;
};

const sortBySeedsDesc = (a: YtsTorrent, b: YtsTorrent): number => {
  const aSeeds = typeof a.seeds === "number" ? a.seeds : 0;
  const bSeeds = typeof b.seeds === "number" ? b.seeds : 0;
  return bSeeds - aSeeds;
};

const buildBehaviorHints = (torrent: YtsTorrent): Stream["behaviorHints"] | undefined => {
  if (typeof torrent.size_bytes === "number" && torrent.size_bytes > 0) {
    return { videoSize: torrent.size_bytes };
  }
  return undefined;
};

export const scrapeYtsStreams = async (
  parsed: ParsedStremioId,
  ytsUrls: string[]
): Promise<StreamResponse> => {
  const imdbId = parsed.baseId;
  const responses = await Promise.allSettled(
    ytsUrls.map((baseUrl) => fetchJson<YtsResponse>(buildListUrl(baseUrl, imdbId)))
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
      (movie.torrents ?? []).slice().sort(sortBySeedsDesc).map((torrent) => ({ movie, torrent }))
    )
    .map(({ movie, torrent }) => {
      const key = torrent.hash;
      if (!torrent.hash || seen.has(key)) {
        return null;
      }
      seen.add(key);
      const imdbTitle = movie.title_long || movie.title || "YTS";
      const torrentName = `${imdbTitle} ${torrent.quality} ${torrent.type}`.trim();
      const qualityLabel = [torrent.quality, torrent.type].filter(Boolean).join(" ");
      const display = formatStreamDisplay({
        addonPrefix: "LT",
        imdbTitle,
        torrentName,
        quality: qualityLabel,
        seeders: torrent.seeds,
        sizeBytes: torrent.size_bytes
      });
      return {
        name: display.name,
        title: display.title,
        description: display.description,
        infoHash: torrent.hash.toLowerCase(),
        behaviorHints: buildBehaviorHints(torrent),
        seeders: torrent.seeds
      };
    })
    .filter((stream): stream is NonNullable<typeof stream> => Boolean(stream));

  return { streams };
};
