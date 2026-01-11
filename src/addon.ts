import { addonBuilder } from "stremio-addon-sdk";
import { getCache, setCache } from "./cache/redis.js";
import { parseStremioId, type ParsedStremioId } from "./parsing/stremioId.js";
import { BadRequestError } from "./types.js";

export const CACHE_TTL_SECONDS = 604800;

export const manifest = {
  id: "lazy.torrentio",
  version: "1.0.0",
  name: "lazy-torrentio",
  description: "On-demand streams addon",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
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

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "movie" && type !== "series") {
    throw new BadRequestError("Invalid type");
  }

  const parsed = parseStremioId(id);
  const key = buildCacheKey(type, parsed);
  const cached = await getCache(key);

  if (cached) {
    return JSON.parse(cached);
  }

  const response = { streams: [] };
  await setCache(key, JSON.stringify(response), CACHE_TTL_SECONDS);
  return response;
});

export const addonInterface = builder.getInterface();
