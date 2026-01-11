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
};

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

const fetchJson = async (url: string): Promise<EztvResponse | null> => {
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
    return (await response.json()) as EztvResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const getImdbDigits = (baseId: string): string => baseId.replace(/^tt/, "");

const matchesEpisode = (torrent: EztvTorrent, season?: number, episode?: number): boolean => {
  if (!season || !episode) {
    return true;
  }

  const torrentSeason = Number(torrent.season);
  const torrentEpisode = Number(torrent.episode);
  return torrentSeason === season && torrentEpisode === episode;
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
  const responses = await Promise.allSettled(
    eztvUrls.map((baseUrl) => {
      const normalized = normalizeBaseUrl(baseUrl);
      const url = `${normalized}/api/get-torrents?imdb_id=${imdbDigits}`;
      return fetchJson(url);
    })
  );

  const torrents = responses.flatMap((result) => {
    if (result.status !== "fulfilled") {
      return [];
    }
    return result.value?.torrents ?? [];
  });

  const seen = new Set<string>();
  const streams = torrents
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

  return { streams };
};
