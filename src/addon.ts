import { addonBuilder } from "stremio-addon-sdk";
import type { StreamHandlerArgs } from "stremio-addon-sdk";
import { getCache, setCache } from "./cache/redis.js";
import { parseStremioId, type ParsedStremioId } from "./parsing/stremioId.js";
import { scrapeEztvStreams } from "./scrapers/eztv.js";
import { scrapeTorrentGalaxyStreams } from "./scrapers/torrentGalaxy.js";
import { scrapeYtsStreams } from "./scrapers/yts.js";
import type { AppConfig } from "./config.js";
import { BadRequestError, type StreamResponse } from "./types.js";
import { getTitleBasics } from "./imdb/index.js";

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

const resolveImdbTitle = async (imdbId: string): Promise<string> => {
  const basics = await getTitleBasics(imdbId);
  return basics?.primaryTitle || basics?.originalTitle || imdbId;
};

const summarizeSources = (streams: StreamResponse["streams"]): Record<string, number> => {
  const counts = new Map<string, number>();
  for (const stream of streams) {
    const source = stream.name?.trim() || "unknown";
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
};

const logStreamRequest = (params: {
  type: string;
  id: string;
  imdbTitle: string;
  cacheHit: boolean;
  durationMs: number;
  streamCount: number;
  sourceCounts: Record<string, number>;
}): void => {
  const payload = {
    type: params.type,
    id: params.id,
    imdbTitle: params.imdbTitle,
    cacheHit: params.cacheHit,
    durationMs: Number(params.durationMs.toFixed(2)),
    magnetLinks: params.streamCount,
    sources: params.sourceCounts
  };
  console.info(`[stream] ${JSON.stringify(payload)}`);
};

export const createAddonInterface = (config: AppConfig) => {
  const builder = new addonBuilder(manifest);

  builder.defineStreamHandler(async ({ type, id }: StreamHandlerArgs) => {
    const startedAt = process.hrtime.bigint();
    if (type !== "movie" && type !== "series") {
      throw new BadRequestError("Invalid type");
    }

    const parsed = parseStremioId(id);
    const key = buildCacheKey(type, parsed);
    const imdbTitlePromise = resolveImdbTitle(parsed.baseId);
    const cached = await getCache(key);

    if (cached) {
      const response = JSON.parse(cached) as StreamResponse;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      logStreamRequest({
        type,
        id,
        imdbTitle: await imdbTitlePromise,
        cacheHit: true,
        durationMs,
        streamCount: response.streams.length,
        sourceCounts: summarizeSources(response.streams)
      });
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

    const response: StreamResponse = { streams: streams.slice().sort(sortBySeedersDesc) };
    await setCache(key, JSON.stringify(response), CACHE_TTL_SECONDS);
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logStreamRequest({
      type,
      id,
      imdbTitle: await imdbTitlePromise,
      cacheHit: false,
      durationMs,
      streamCount: response.streams.length,
      sourceCounts: summarizeSources(response.streams)
    });
    return response;
  });

  return builder.getInterface();
};
