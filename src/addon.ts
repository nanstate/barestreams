import type { StreamHandlerArgs } from "stremio-addon-sdk";
import { addonBuilder } from "stremio-addon-sdk";
import { setMaxListeners } from "node:events";
import { getCache, setCache } from "./cache/redis.js";
import { config } from "./config.js";
import { getTitleBasics } from "./imdb/index.js";
import { parseStremioId, type ParsedStremioId } from "./parsing/stremioId.js";
import type { ScrapeContext } from "./scrapers/context.js";
import { scrapeEztvStreams } from "./scrapers/eztv.js";
import { scrapePirateBayStreams } from "./scrapers/pirateBay.js";
import { scrapeTorrentGalaxyStreams } from "./scrapers/torrentGalaxy.js";
import { scrapeX1337xStreams } from "./scrapers/x1337x.js";
import { scrapeYtsStreams } from "./scrapers/yts.js";
import { extractQualityHint } from "./streams/quality.js";
import { BadRequestError, type Stream, type StreamResponse } from "./types.js";

export const manifest = {
	id: "barestreams",
	version: "1.0.0",
	name: "barestreams",
	description:
		"Lightweight Stremio addon for torrent streams from multiple public sources.",
	resources: ["stream"],
	types: ["movie", "series"],
	idPrefixes: ["tt"],
	catalogs: [],
	behaviorHints: {
		p2p: true,
	},
};

const sortBySeedersDesc = (
	a: { seeders?: number },
	b: { seeders?: number },
): number => {
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

const extractSourceFromDescription = (description?: string): string | null => {
	if (!description) {
		return null;
	}
	const lines = description.split("\n").reverse();
	for (const line of lines) {
		const sourceMatch = line.match(/🔗\s*([^•]+)\s*$/);
		if (sourceMatch) {
			return sourceMatch[1].trim();
		}
		const match = line.match(/\(([^)]+)\)\s*$/);
		if (match) {
			return match[1].trim();
		}
	}
	return null;
};

const summarizeSources = (
	streams: StreamResponse["streams"],
): Record<string, number> => {
	const counts = new Map<string, number>();
	for (const stream of streams) {
		const source =
			extractSourceFromDescription(stream.description) || "unknown";
		counts.set(source, (counts.get(source) ?? 0) + 1);
	}
	return Object.fromEntries(counts);
};

const normalizeBingeSegment = (value: string): string =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

const extractStreamQuality = (stream: Stream): string | null => {
	const text = [stream.description, stream.name].filter(Boolean).join(" ");
	return extractQualityHint(text);
};

const applyBingeGroup = (
	stream: Stream,
	parsed: ParsedStremioId,
	type: string,
): Stream => {
	if (type !== "series" || !parsed.season || !parsed.episode) {
		return stream;
	}
	if (stream.behaviorHints?.bingeGroup) {
		return stream;
	}
	const quality = extractStreamQuality(stream) ?? "unknown";
	const source = normalizeBingeSegment(
		extractSourceFromDescription(stream.description) ?? "stream",
	);
	const bingeGroup = `barestreams-${source}-${quality}`;
	return {
		...stream,
		behaviorHints: {
			...stream.behaviorHints,
			bingeGroup,
		},
	};
};

const stripStreamExtras = (stream: Stream): Stream => {
	const { seeders, ...rest } = stream;
	return rest;
};

const isZeroSeederMagnet = (stream: Stream): boolean => {
	if (typeof stream.seeders !== "number" || stream.seeders > 0) {
		return false;
	}
	if (stream.infoHash) {
		return true;
	}
	return Boolean(stream.url && stream.url.startsWith("magnet:?"));
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
		sources: params.sourceCounts,
	};
	console.info(`[stream] ${JSON.stringify(payload)}`);
};

const createScrapeContext = (
	timeoutSeconds: number | null,
): { context: ScrapeContext; clear: () => void } => {
	if (!timeoutSeconds || timeoutSeconds <= 0) {
		return {
			context: { signal: null },
			clear: () => {},
		};
	}
	const timeoutMs = Math.ceil(timeoutSeconds * 1000);
	const controller = new AbortController();
	setMaxListeners(0, controller.signal);
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	return {
		context: { signal: controller.signal },
		clear: () => clearTimeout(timeout),
	};
};

export const createAddonInterface = () => {
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
			const durationMs =
				Number(process.hrtime.bigint() - startedAt) / 1_000_000;
			logStreamRequest({
				type,
				id,
				imdbTitle: await imdbTitlePromise,
				cacheHit: true,
				durationMs,
				streamCount: response.streams.length,
				sourceCounts: summarizeSources(response.streams),
			});
			return response;
		}

		const { context: scrapeContext, clear: clearScrapeTimeout } =
			createScrapeContext(config.maxRequestWaitSeconds);
		let responses: PromiseSettledResult<StreamResponse>[] = [];
		try {
			responses = await Promise.allSettled(
				type === "movie"
					? [
							scrapeYtsStreams(parsed, scrapeContext),
							scrapeTorrentGalaxyStreams(parsed, scrapeContext),
							scrapePirateBayStreams(parsed, "movie", scrapeContext),
							scrapeX1337xStreams(parsed, scrapeContext),
						]
					: [
							scrapeEztvStreams(parsed, scrapeContext),
							scrapeTorrentGalaxyStreams(parsed, scrapeContext),
							scrapePirateBayStreams(parsed, "series", scrapeContext),
							scrapeX1337xStreams(parsed, scrapeContext),
						],
			);
		} finally {
			clearScrapeTimeout();
		}

		const seen = new Map<string, Stream>();
		const streams = responses.flatMap((result) => {
			if (result.status !== "fulfilled") {
				return [];
			}
			return result.value.streams.filter((stream) => {
				const key = stream.infoHash ?? stream.url ?? "";
				if (!key) {
					return false;
				}
				const existing = seen.get(key);
				if (existing) {
					if (existing.sources || stream.sources) {
						const merged = new Set([
							...(existing.sources ?? []),
							...(stream.sources ?? []),
						]);
						if (merged.size > 0) {
							existing.sources = Array.from(merged);
						}
					}
					return false;
				}
				seen.set(key, stream);
				return true;
			});
		});
		const filteredStreams = streams.filter(
			(stream) => !isZeroSeederMagnet(stream),
		);

		const sortedStreams = filteredStreams.slice().sort(sortBySeedersDesc);
		const response: StreamResponse = {
			streams: sortedStreams.map((stream) =>
				stripStreamExtras(applyBingeGroup(stream, parsed, type)),
			),
		};
		if (response.streams.length > 0) {
			await setCache(key, JSON.stringify(response));
		}
		const durationMs =
			Number(process.hrtime.bigint() - startedAt) / 1_000_000;
		logStreamRequest({
			type,
			id,
			imdbTitle: await imdbTitlePromise,
			cacheHit: false,
			durationMs,
			streamCount: response.streams.length,
			sourceCounts: summarizeSources(response.streams),
		});
		return response;
	});

	return builder.getInterface();
};
