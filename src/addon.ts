import { addonBuilder } from "stremio-addon-sdk";
import type { StreamHandlerArgs } from "stremio-addon-sdk";
import { getCache, setCache } from "./cache/redis.js";
import { parseStremioId, type ParsedStremioId } from "./parsing/stremioId.js";
import { scrapeEztvStreams } from "./scrapers/eztv.js";
import { scrapeTorrentGalaxyStreams } from "./scrapers/torrentGalaxy.js";
import { scrapeYtsStreams } from "./scrapers/yts.js";
import type { AppConfig } from "./config.js";
import { BadRequestError, type Stream, type StreamResponse } from "./types.js";

export const CACHE_TTL_SECONDS = 604800;

export const manifest = {
  id: "lazy.torrentio",
  version: "1.0.0",
  name: "lazy-torrentio",
  description: "On-demand streams addon",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: []
};

const sortBySeedersDesc = (a: { seeders?: number }, b: { seeders?: number }): number => {
  const aSeeds = typeof a.seeders === "number" ? a.seeders : 0;
  const bSeeds = typeof b.seeders === "number" ? b.seeders : 0;
  return bSeeds - aSeeds;
};

const buildCacheKey = (type: string, parsed: ParsedStremioId): string => {
  if (type === "movie") {
    return `stream:movie:${parsed.baseId}`;
  }

  if (type !== "series") {
    throw new BadRequestError("Invalid type");
  }

  if (parsed.season && parsed.episode) {
    return `stream:series:${parsed.baseId}:${parsed.season}:${parsed.episode}`;
  }

  return `stream:series:${parsed.baseId}`;
};

const normalizeBingeSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const extractQualityHint = (stream: Stream): string | null => {
  const text = [stream.title, stream.description, stream.name].filter(Boolean).join(" ");
  const match = text.match(/\b(2160p|1080p|720p|480p|4k|uhd)\b/i);
  if (!match) {
    return null;
  }
  const quality = match[1].toLowerCase();
  if (quality === "4k" || quality === "uhd") {
    return "2160p";
  }
  return quality;
};

const applyBingeGroup = (stream: Stream, parsed: ParsedStremioId, type: string): Stream => {
  if (type !== "series" || !parsed.season || !parsed.episode) {
    return stream;
  }
  if (stream.behaviorHints?.bingeGroup) {
    return stream;
  }
  const quality = extractQualityHint(stream) ?? "unknown";
  const source = normalizeBingeSegment(stream.name ?? "stream");
  const bingeGroup = `lazy-torrentio-${source}-${quality}`;
  return {
    ...stream,
    behaviorHints: {
      ...stream.behaviorHints,
      bingeGroup
    }
  };
};

const stripStreamExtras = (stream: Stream): Stream => {
  const { seeders, ...rest } = stream;
  return rest;
};

export const createAddonInterface = (config: AppConfig) => {
  const builder = new addonBuilder(manifest);

  builder.defineStreamHandler(async ({ type, id }: StreamHandlerArgs) => {
    if (type !== "movie" && type !== "series") {
      throw new BadRequestError("Invalid type");
    }

    const parsed = parseStremioId(id);
    const key = buildCacheKey(type, parsed);
    const cached = await getCache(key);

    if (cached) {
      const response = JSON.parse(cached) as StreamResponse;
      return response;
    }

    const responses = await Promise.allSettled(
      type === "movie"
        ? [
            scrapeYtsStreams(parsed, config.ytsUrls),
            scrapeTorrentGalaxyStreams(parsed, config.tgxUrls)
          ]
        : [
            scrapeEztvStreams(parsed, config.eztvUrls),
            scrapeTorrentGalaxyStreams(parsed, config.tgxUrls)
          ]
    );

    const seen = new Set<string>();
    const streams = responses.flatMap((result) => {
      if (result.status !== "fulfilled") {
        return [];
      }
      return result.value.streams.filter((stream) => {
        const key = stream.infoHash ?? stream.url ?? "";
        if (!key || seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    });

    const sortedStreams = streams.slice().sort(sortBySeedersDesc);
    const response: StreamResponse = {
      streams: sortedStreams.map((stream) => stripStreamExtras(applyBingeGroup(stream, parsed, type)))
    };
    await setCache(key, JSON.stringify(response), CACHE_TTL_SECONDS);
    return response;
  });

  return builder.getInterface();
};
