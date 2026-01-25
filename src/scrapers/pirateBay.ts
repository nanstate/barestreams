import type { ParsedStremioId } from "../parsing/stremioId.js";
import { parseMagnet } from "../parsing/magnet.js";
import { extractQualityHint } from "../streams/quality.js";
import { formatStreamDisplay } from "../streams/display.js";
import { config } from "../config.js";
import type { Stream, StreamResponse } from "../types.js";
import { fetchJson, normalizeBaseUrl, ScraperKey } from "./http.js";
import { logScraperWarning } from "./logging.js";
import { buildQueries, matchesEpisode } from "./query.js";
import { shouldAbort, type ScrapeContext } from "./context.js";

type PirateBayResult = {
	title?: string;
	magnet?: string;
	sizeBytes?: number;
	seeders: number;
	leechers: number;
};

type PirateBayApiResult = {
	id?: string;
	name?: string;
	info_hash?: string;
	seeders?: string | number;
	leechers?: string | number;
	size?: string | number;
};

const MOVIE_CATEGORIES = [207, 201];
const SERIES_CATEGORIES = [208, 205];

const resolveApiBase = (baseUrl: string): string | null => {
	const normalized = normalizeBaseUrl(baseUrl);
	try {
		const url = new URL(normalized);
		if (url.hostname.includes("apibay.org")) {
			return normalized;
		}
	} catch {
		return null;
	}
	return normalized;
};

const buildSearchUrl = (
	apiBase: string,
	query: string,
	category: number,
): string => {
	const normalized = normalizeBaseUrl(apiBase);
	const params = new URLSearchParams({ q: query, cat: category.toString() });
	return `${normalized}/q.php?${params.toString()}`;
};

const parseSizeToBytes = (rawSize?: string | number): number | undefined => {
	if (rawSize === undefined || rawSize === null) {
		return undefined;
	}
	const value =
		typeof rawSize === "string" ? Number.parseFloat(rawSize) : rawSize;
	if (!Number.isFinite(value)) {
		return undefined;
	}
	return Math.round(value);
};

const extractFilename = (name?: string): string | undefined => {
	if (!name) {
		return undefined;
	}
	const match = name.match(/\b([^\s/\\]+?\.(?:mkv|mp4|avi|ts|m4v))\b/i);
	return match?.[1];
};

const buildBehaviorHints = (
	result: PirateBayResult,
): Stream["behaviorHints"] | undefined => {
	const hints: Stream["behaviorHints"] = {};
	if (result.sizeBytes && result.sizeBytes > 0) {
		hints.videoSize = result.sizeBytes;
	}
	const filename = extractFilename(result.title);
	if (filename) {
		hints.filename = filename;
	}
	return Object.keys(hints).length > 0 ? hints : undefined;
};

const parseSearchResults = (
	payload: PirateBayApiResult[],
	limit: number,
): PirateBayResult[] => {
	const results: PirateBayResult[] = [];
	for (const entry of payload) {
		if (results.length >= limit) {
			break;
		}
		const title = entry.name?.trim() || undefined;
		const infoHash = entry.info_hash?.trim();
		const magnet = infoHash ? `magnet:?xt=urn:btih:${infoHash}` : undefined;
		const sizeBytes = parseSizeToBytes(entry.size);
		const seeders = Number(entry.seeders);
		const leechers = Number(entry.leechers);
		results.push({
			title,
			magnet,
			sizeBytes,
			seeders: Number.isFinite(seeders) ? seeders : 0,
			leechers: Number.isFinite(leechers) ? leechers : 0,
		});
	}
	return results;
};

const dedupeResults = (results: PirateBayResult[]): PirateBayResult[] => {
	const seen = new Set<string>();
	const deduped: PirateBayResult[] = [];
	for (const result of results) {
		const key = result.magnet || result.title || "";
		if (!key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(result);
	}
	return deduped;
};

export const scrapePirateBayStreams = async (
	parsed: ParsedStremioId,
	type: "movie" | "series",
	context: ScrapeContext,
): Promise<StreamResponse> => {
	if (config.apiBayUrls.length === 0 || shouldAbort(context)) {
		return { streams: [] };
	}
	const { baseTitle, query, fallbackQuery, episodeSuffix } =
		await buildQueries(parsed);
	if (shouldAbort(context)) {
		return { streams: [] };
	}
	const categories = type === "movie" ? MOVIE_CATEGORIES : SERIES_CATEGORIES;
	const fetchResultsForQuery = async (
		searchQuery: string,
	): Promise<PirateBayResult[]> => {
		if (shouldAbort(context)) {
			return [];
		}
		const tasks = config.apiBayUrls.flatMap((baseUrl) =>
			categories.map((category) => ({
				baseUrl,
				category,
			})),
		);
		const responses = await Promise.allSettled(
			tasks.map(({ baseUrl, category }) => {
				const apiBase = resolveApiBase(baseUrl);
				if (!apiBase) {
					return Promise.resolve(null);
				}
				return fetchJson<PirateBayApiResult[]>(
					buildSearchUrl(apiBase, searchQuery, category),
					{ scraper: ScraperKey.Tpb, signal: context.signal },
				);
			}),
		);
		const results: PirateBayResult[] = [];
		for (let index = 0; index < tasks.length; index += 1) {
			if (results.length >= 20) {
				break;
			}
			const response = responses[index];
			if (response.status !== "fulfilled") {
				continue;
			}
			const payload = response.value;
			if (!payload || !Array.isArray(payload)) {
				continue;
			}
			results.push(...parseSearchResults(payload, 20 - results.length));
		}
		return results;
	};

	const results = await fetchResultsForQuery(query);

	let filtered = results;
	if (results.length === 0 && fallbackQuery && !shouldAbort(context)) {
		filtered = await fetchResultsForQuery(fallbackQuery);
	}

	if (episodeSuffix) {
		filtered = filtered.filter((result) =>
			matchesEpisode(result.title, parsed.season, parsed.episode),
		);
	}

	const uniqueResults = dedupeResults(filtered);
	const streams = uniqueResults
		.map((result) => {
			if (!result.magnet) {
				return null;
			}
			const parsedMagnet = parseMagnet(result.magnet);
			if (!parsedMagnet) {
				return null;
			}
			const quality = extractQualityHint(result.title ?? "");
			const sizeBytes = result.sizeBytes ?? null;
			const display = formatStreamDisplay({
				imdbTitle: baseTitle,
				season: parsed.season,
				episode: parsed.episode,
				torrentName: result.title,
				quality,
				source: "TPB",
				seeders: result.seeders,
				sizeBytes,
				sizeLabel: null,
			});
			return {
				name: display.name,
				description: display.description,
				infoHash: parsedMagnet.infoHash,
				sources: parsedMagnet.sources,
				behaviorHints: buildBehaviorHints(result),
				seeders: result.seeders,
			};
		})
		.filter((stream): stream is NonNullable<typeof stream> =>
			Boolean(stream),
		);

	if (streams.length === 0 && !shouldAbort(context)) {
		logScraperWarning("PirateBay", "no results", {
			type,
			baseTitle,
			query,
			fallbackQuery,
		});
	}

	return { streams };
};
