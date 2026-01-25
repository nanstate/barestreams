import { load } from "cheerio";
import type { ParsedStremioId } from "../parsing/stremioId.js";
import { parseMagnet } from "../parsing/magnet.js";
import { extractQualityHint } from "../streams/quality.js";
import { formatStreamDisplay } from "../streams/display.js";
import { config } from "../config.js";
import type { Stream, StreamResponse } from "../types.js";
import { fetchText, normalizeBaseUrl, ScraperKey } from "./http.js";
import { buildQueries, matchesEpisode } from "./query.js";
import { logScraperWarning } from "./logging.js";
import { TGX_DETAIL_LIMIT } from "./limits.js";
import { shouldAbort, type ScrapeContext } from "./context.js";

type TorrentGalaxyLink = {
	name: string;
	url: string;
	seeders: number;
	leechers: number;
	size: string;
};

type TorrentGalaxyDetails = {
	magnetURI?: string;
	torrentDownload?: string;
};

const fetchHtml = (
	url: string,
	context: ScrapeContext,
): Promise<string | null> =>
	fetchText(url, { scraper: ScraperKey.Tgx, signal: context.signal });

const buildSearchUrl = (
	baseUrl: string,
	query: string,
	page: number,
): string => {
	const normalized = normalizeBaseUrl(baseUrl);
	const params = new URLSearchParams({
		q: query,
		category: "lmsearch",
		page: page.toString(),
	});
	return `${normalized}/lmsearch?${params.toString()}`;
};

const parseSearchResults = (
	html: string,
	baseUrl: string,
	limit: number,
): TorrentGalaxyLink[] => {
	const $ = load(html);
	const results: TorrentGalaxyLink[] = [];
	const rows = $(".table-list-wrap tbody tr");
	rows.each((_, element) => {
		if (results.length >= limit) {
			return;
		}
		const anchor = $(element).find("td .tt-name a").eq(0);
		const name = anchor.text().trim();
		const href = anchor.attr("href");
		if (!href) {
			return;
		}
		const url = new URL(href, baseUrl).toString();
		const tds = $(element).find("td");
		const size = $(tds[2]).text().trim();
		const seeders = Number($(tds[3]).text().trim().replace(/,/g, ""));
		const leechers = Number($(tds[4]).text().trim().replace(/,/g, ""));
		results.push({
			name,
			url,
			seeders: Number.isFinite(seeders) ? seeders : 0,
			leechers: Number.isFinite(leechers) ? leechers : 0,
			size,
		});
	});
	return results;
};

const searchTorrentGalaxy = async (
	baseUrl: string,
	query: string,
	limit: number,
	context: ScrapeContext,
): Promise<TorrentGalaxyLink[]> => {
	const results: TorrentGalaxyLink[] = [];
	const normalizedBase = normalizeBaseUrl(baseUrl);
	let page = 1;
	while (results.length < limit && !shouldAbort(context)) {
		const html = await fetchHtml(
			buildSearchUrl(normalizedBase, query, page),
			context,
		);
		if (!html) {
			break;
		}
		const batch = parseSearchResults(
			html,
			normalizedBase,
			limit - results.length,
		);
		if (batch.length === 0) {
			break;
		}
		results.push(...batch);
		page += 1;
	}
	return results;
};

const fetchTorrentDetails = async (
	url: string,
	context: ScrapeContext,
): Promise<TorrentGalaxyDetails | null> => {
	const html = await fetchHtml(url, context);
	if (!html) {
		return null;
	}
	const $ = load(html);
	const magnetURI = $("a[href^='magnet:?']").attr("href");
	const torrentDownload = $("a[href$='.torrent']").attr("href");
	const resolvedDownload = torrentDownload
		? new URL(torrentDownload, url).toString()
		: undefined;
	return { magnetURI, torrentDownload: resolvedDownload };
};

const parseSizeToBytes = (rawSize: string): number | null => {
	const match = rawSize
		.trim()
		.match(/([\d.]+)\s*(B|KB|MB|GB|TB|KIB|MIB|GIB|TIB)/i);
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
		TIB: 1024 ** 4,
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

const buildBehaviorHints = (
	link: TorrentGalaxyLink,
): Stream["behaviorHints"] | undefined => {
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

const dedupeLinks = (links: TorrentGalaxyLink[]): TorrentGalaxyLink[] => {
	const seen = new Set<string>();
	const results: TorrentGalaxyLink[] = [];
	for (const link of links) {
		if (seen.has(link.url)) {
			continue;
		}
		seen.add(link.url);
		results.push(link);
	}
	return results;
};

const sortBySeedersDesc = (
	a: TorrentGalaxyLink,
	b: TorrentGalaxyLink,
): number => b.seeders - a.seeders;

export const scrapeTorrentGalaxyStreams = async (
	parsed: ParsedStremioId,
	context: ScrapeContext,
): Promise<StreamResponse> => {
	if (config.tgxUrls.length === 0 || shouldAbort(context)) {
		return { streams: [] };
	}
	const { baseTitle, query, fallbackQuery, episodeSuffix } =
		await buildQueries(parsed);
	if (shouldAbort(context)) {
		return { streams: [] };
	}
	const links: TorrentGalaxyLink[] = [];

	for (const baseUrl of config.tgxUrls) {
		if (links.length >= TGX_DETAIL_LIMIT || shouldAbort(context)) {
			break;
		}
		const batch = await searchTorrentGalaxy(
			baseUrl,
			query,
			TGX_DETAIL_LIMIT - links.length,
			context,
		);
		links.push(...batch);
	}

	let filteredLinks = links;
	if (links.length === 0 && fallbackQuery && !shouldAbort(context)) {
		for (const baseUrl of config.tgxUrls) {
			if (filteredLinks.length >= TGX_DETAIL_LIMIT || shouldAbort(context)) {
				break;
			}
			const batch = await searchTorrentGalaxy(
				baseUrl,
				fallbackQuery,
				TGX_DETAIL_LIMIT - filteredLinks.length,
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
	if (shouldAbort(context)) {
		return { streams: [] };
	}
	const detailResults = await Promise.allSettled(
		sortedLinks.map((link) => fetchTorrentDetails(link.url, context)),
	);

	const streams = sortedLinks
		.map((link, index) => {
			const detailResult = detailResults[index];
			if (detailResult.status !== "fulfilled") {
				return null;
			}
			const details = detailResult.value;
			if (!details) {
				return null;
			}
			const magnet = details.magnetURI;
			if (!magnet) {
				return null;
			}
			const parsedMagnet = parseMagnet(magnet);
			if (!parsedMagnet) {
				return null;
			}
			const quality = extractQualityHint(link.name);
			const sizeBytes = link.size ? parseSizeToBytes(link.size) : null;
			const display = formatStreamDisplay({
				imdbTitle: baseTitle,
				season: parsed.season,
				episode: parsed.episode,
				torrentName: link.name,
				quality,
				source: "TGX",
				seeders: link.seeders,
				sizeBytes,
				sizeLabel: link.size,
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
		logScraperWarning("TorrentGalaxy", "no results", {
			baseTitle,
			query,
			fallbackQuery,
		});
	}

	return { streams };
};
