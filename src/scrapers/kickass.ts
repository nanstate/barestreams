import { load } from "cheerio";
import type { Cheerio } from "cheerio";
import type { Element } from "domhandler";
import type { ParsedStremioId } from "../parsing/stremioId.js";
import { parseMagnet } from "../parsing/magnet.js";
import { extractQualityHint } from "../streams/quality.js";
import { formatStreamDisplay } from "../streams/display.js";
import { config } from "../config.js";
import type { Stream, StreamResponse } from "../types.js";
import type { FlareSolverrPoolConfig } from "./flareSolverrPools.js";
import {
	applyFlareSolverrSessionCap,
	registerFlareSolverrPoolConfigProvider,
} from "./flareSolverrPools.js";
import { fetchText, normalizeBaseUrl } from "./http.js";
import { ScraperKey } from "./keys.js";
import { buildQueries, matchesEpisode } from "./query.js";
import { logScraperWarning } from "./logging.js";
import { shouldAbort, type ScrapeContext } from "./context.js";
import { extractFilename, parseNumber, parseSizeToBytes } from "./utils.js";

type KickassLink = {
	name: string;
	url: string;
	magnet: string | null;
	seeders: number;
	leechers: number;
	sizeLabel: string;
};

const KAT_DETAIL_LIMIT = 20;

const buildFlareSolverrPoolConfig = (): FlareSolverrPoolConfig | null => {
	if (config.katUrls.length === 0) {
		return null;
	}
	return {
		key: ScraperKey.Kat,
		sessionCount: applyFlareSolverrSessionCap(KAT_DETAIL_LIMIT),
		warmupUrl: normalizeBaseUrl(config.katUrls[0]),
	};
};

registerFlareSolverrPoolConfigProvider(
	ScraperKey.Kat,
	buildFlareSolverrPoolConfig,
);

const fetchHtml = (
	url: string,
	context: ScrapeContext,
): Promise<string | null> =>
	fetchText(url, { scraper: ScraperKey.Kat, signal: context.signal });

const buildSearchUrl = (baseUrl: string, query: string): string => {
	const normalized = normalizeBaseUrl(baseUrl);
	const encoded = encodeURIComponent(query);
	return `${normalized}/usearch/${encoded}/`;
};

const extractMagnetFromRow = ($row: Cheerio<Element>): string | null => {
	const magnet =
		$row.find("a[href^='magnet:']").first().attr("href") ??
		$row.find("a.imagnet").first().attr("href");
	return magnet ?? null;
};

const parseSearchResults = (
	html: string,
	baseUrl: string,
	limit: number,
): KickassLink[] => {
	const $ = load(html);
	const results: KickassLink[] = [];
	const rows = $("tr.odd, tr.even");
	rows.each((_, element) => {
		if (results.length >= limit) {
			return;
		}
		const row = $(element);
		const anchor = row.find("a.cellMainLink").first();
		const name = anchor.text().trim();
		const href = anchor.attr("href");
		if (!href || !name) {
			return;
		}
		const url = new URL(href, baseUrl).toString();
		const tds = row.find("td.center");
		const sizeLabel = $(tds[0]).text().trim();
		const seeders = parseNumber($(tds[3]).text());
		const leechers = parseNumber($(tds[4]).text());
		const magnet = extractMagnetFromRow(row);
		results.push({
			name,
			url,
			magnet,
			seeders,
			leechers,
			sizeLabel,
		});
	});
	return results;
};

const searchKickass = async (
	baseUrl: string,
	query: string,
	limit: number,
	context: ScrapeContext,
): Promise<KickassLink[]> => {
	const html = await fetchHtml(buildSearchUrl(baseUrl, query), context);
	if (!html) {
		return [];
	}
	return parseSearchResults(html, baseUrl, limit);
};

const fetchTorrentMagnet = async (
	url: string,
	context: ScrapeContext,
): Promise<string | null> => {
	const html = await fetchHtml(url, context);
	if (!html) {
		return null;
	}
	const $ = load(html);
	const magnet =
		$("a.kaGiantButton").attr("href") ??
		$("a[href^='magnet:']").first().attr("href") ??
		$("a.siteButton.giantIcon.magnetlinkButton").attr("href");
	return magnet ?? null;
};

const buildBehaviorHints = (
	link: KickassLink,
): Stream["behaviorHints"] | undefined => {
	const hints: Stream["behaviorHints"] = {};
	const sizeBytes = link.sizeLabel
		? parseSizeToBytes(link.sizeLabel)
		: null;
	if (sizeBytes && sizeBytes > 0) {
		hints.videoSize = sizeBytes;
	}
	const filename = extractFilename(link.name);
	if (filename) {
		hints.filename = filename;
	}
	return Object.keys(hints).length > 0 ? hints : undefined;
};

const dedupeLinks = (links: KickassLink[]): KickassLink[] => {
	const seen = new Set<string>();
	const results: KickassLink[] = [];
	for (const link of links) {
		const key = link.magnet ?? link.url;
		if (!key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		results.push(link);
	}
	return results;
};

const sortBySeedersDesc = (a: KickassLink, b: KickassLink): number =>
	b.seeders - a.seeders;

export const scrapeKickassStreams = async (
	parsed: ParsedStremioId,
	type: "movie" | "series",
	context: ScrapeContext,
): Promise<StreamResponse> => {
	if (config.katUrls.length === 0 || shouldAbort(context)) {
		return { streams: [] };
	}
	const { baseTitle, query, fallbackQuery, episodeSuffix } =
		await buildQueries(parsed);
	if (shouldAbort(context)) {
		return { streams: [] };
	}
	const links: KickassLink[] = [];
	for (const baseUrl of config.katUrls) {
		if (links.length >= KAT_DETAIL_LIMIT || shouldAbort(context)) {
			break;
		}
		const batch = await searchKickass(
			baseUrl,
			query,
			KAT_DETAIL_LIMIT - links.length,
			context,
		);
		links.push(...batch);
	}

	let filteredLinks = links;
	if (links.length === 0 && fallbackQuery && !shouldAbort(context)) {
		for (const baseUrl of config.katUrls) {
			if (filteredLinks.length >= KAT_DETAIL_LIMIT || shouldAbort(context)) {
				break;
			}
			const batch = await searchKickass(
				baseUrl,
				fallbackQuery,
				KAT_DETAIL_LIMIT - filteredLinks.length,
				context,
			);
			filteredLinks.push(...batch);
		}
	}

	if (episodeSuffix) {
		filteredLinks = filteredLinks.filter((link) =>
			matchesEpisode(link.name, parsed.season, parsed.episode),
		);
	}

	const uniqueLinks = dedupeLinks(filteredLinks);
	const sortedLinks = uniqueLinks.slice().sort(sortBySeedersDesc);
	const topLinks = sortedLinks.slice(0, KAT_DETAIL_LIMIT);
	if (shouldAbort(context)) {
		return { streams: [] };
	}
	const magnetResults = await Promise.allSettled(
		topLinks.map(async (link) => {
			if (link.magnet) {
				return link.magnet;
			}
			return fetchTorrentMagnet(link.url, context);
		}),
	);

	const streams = topLinks
		.map((link, index) => {
			const magnetResult = magnetResults[index];
			if (magnetResult.status !== "fulfilled") {
				return null;
			}
			const magnet = magnetResult.value;
			if (!magnet) {
				return null;
			}
			const parsedMagnet = parseMagnet(magnet);
			if (!parsedMagnet) {
				return null;
			}
			const quality = extractQualityHint(link.name);
			const sizeBytes = link.sizeLabel
				? parseSizeToBytes(link.sizeLabel)
				: null;
			const display = formatStreamDisplay({
				imdbTitle: baseTitle,
				season: parsed.season,
				episode: parsed.episode,
				torrentName: link.name,
				quality,
				source: "KAT",
				seeders: link.seeders,
				sizeBytes,
				sizeLabel: link.sizeLabel || null,
			});
			return {
				name: display.name,
				description: display.description,
				infoHash: parsedMagnet.infoHash,
				sources: parsedMagnet.sources,
				behaviorHints: buildBehaviorHints(link),
				seeders: link.seeders,
			};
		})
		.filter((stream): stream is NonNullable<typeof stream> =>
			Boolean(stream),
		);

	if (streams.length === 0 && !shouldAbort(context)) {
		logScraperWarning("Kickass", "no results", {
			type,
			baseTitle,
			query,
			fallbackQuery,
		});
	}

	return { streams };
};
