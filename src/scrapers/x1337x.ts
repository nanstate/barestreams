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
import { shouldAbort, type ScrapeContext } from "./context.js";

type X1337xLink = {
	name: string;
	url: string;
	seeders: number;
	leechers: number;
	size: string;
};

type X1337xDetails = {
	magnetURI?: string;
};

const fetchHtml = async (
	url: string,
	context: ScrapeContext,
): Promise<string | null> => {
	const html = await fetchText(url, {
		scraper: ScraperKey.X1337x,
		signal: context.signal,
	});
	return html;
};

const buildSearchUrl = (
	baseUrl: string,
	query: string,
	page: number,
): string => {
	const normalized = normalizeBaseUrl(baseUrl);
	const encoded = encodeURIComponent(query);
	return `${normalized}/search/${encoded}/${page}/`;
};

const parseNumber = (value: string): number => {
	const parsed = Number(value.replace(/,/g, "").trim());
	return Number.isFinite(parsed) ? parsed : 0;
};

const extractSizeLabel = (value: string): string => {
	const normalized = value.replace(/\s+/g, " ").trim();
	const match = normalized.match(
		/(\d+(?:\.\d+)?\s*(?:KB|MB|GB|TB|KiB|MiB|GiB|TiB))/i,
	);
	return match ? match[1] : normalized;
};

const parseSearchResults = (
	html: string,
	baseUrl: string,
	limit: number,
): X1337xLink[] => {
	const $ = load(html);
	const results: X1337xLink[] = [];
	const rows = $(".table-list tbody tr");
	rows.each((_, element) => {
		if (results.length >= limit) {
			return;
		}
		const anchor = $(element).find("td.name a[href^='/torrent/']").first();
		const name = anchor.text().trim();
		const href = anchor.attr("href");
		if (!href || !name) {
			return;
		}
		const url = new URL(href, baseUrl).toString();
		const seedersText = $(element)
			.find("td.seeds, td.coll-2")
			.first()
			.text();
		const leechersText = $(element)
			.find("td.leeches, td.coll-3")
			.first()
			.text();
		const sizeText = $(element).find("td.size, td.coll-4").first().text();
		const size = extractSizeLabel(sizeText);
		results.push({
			name,
			url,
			seeders: parseNumber(seedersText),
			leechers: parseNumber(leechersText),
			size,
		});
	});
	return results;
};

const searchX1337x = async (
	baseUrl: string,
	query: string,
	limit: number,
	context: ScrapeContext,
): Promise<X1337xLink[]> => {
	const normalizedBase = normalizeBaseUrl(baseUrl);
	const url = buildSearchUrl(normalizedBase, query, 1);
	const html = await fetchHtml(url, context);
	if (!html) {
		return [];
	}
	return parseSearchResults(html, normalizedBase, limit);
};

const fetchTorrentDetails = async (
	url: string,
	context: ScrapeContext,
): Promise<X1337xDetails | null> => {
	const html = await fetchHtml(url, context);
	if (!html) {
		return null;
	}
	const $ = load(html);
	const magnetURI =
		$("a[href^='magnet:?']").attr("href") ??
		$("a[href^='magnet:']").attr("href");
	return { magnetURI };
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
	link: X1337xLink,
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

const dedupeLinks = (links: X1337xLink[]): X1337xLink[] => {
	const seen = new Set<string>();
	const results: X1337xLink[] = [];
	for (const link of links) {
		if (seen.has(link.url)) {
			continue;
		}
		seen.add(link.url);
		results.push(link);
	}
	return results;
};

const sortBySeedersDesc = (a: X1337xLink, b: X1337xLink): number =>
	b.seeders - a.seeders;

export const scrapeX1337xStreams = async (
	parsed: ParsedStremioId,
	context: ScrapeContext,
): Promise<StreamResponse> => {
	const baseUrls = config.x1337xUrls;
	const detailLimit = config.flareSolverrSessions;
	if (baseUrls.length === 0 || detailLimit <= 0 || shouldAbort(context)) {
		return { streams: [] };
	}
	const { baseTitle, query, fallbackQuery, episodeSuffix } =
		await buildQueries(parsed);
	if (shouldAbort(context)) {
		return { streams: [] };
	}
	const searchLimit = Math.max(1, detailLimit);
	const links: X1337xLink[] = [];

	for (const baseUrl of baseUrls) {
		if (links.length >= searchLimit || shouldAbort(context)) {
			break;
		}
		const batch = await searchX1337x(
			baseUrl,
			query,
			searchLimit - links.length,
			context,
		);
		links.push(...batch);
	}

	let filteredLinks = links;
	if (links.length === 0 && fallbackQuery && !shouldAbort(context)) {
		for (const baseUrl of baseUrls) {
			if (filteredLinks.length >= searchLimit || shouldAbort(context)) {
				break;
			}
			const batch = await searchX1337x(
				baseUrl,
				fallbackQuery,
				searchLimit - filteredLinks.length,
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
	const topLinks = sortedLinks.slice(0, detailLimit);
	if (shouldAbort(context)) {
		return { streams: [] };
	}
	const detailResults = await Promise.allSettled(
		topLinks.map((link) => fetchTorrentDetails(link.url, context)),
	);

	const streams = topLinks
		.map((link, index) => {
			const detailResult = detailResults[index];
			if (detailResult.status !== "fulfilled") {
				return null;
			}
			const details = detailResult.value;
			if (!details?.magnetURI) {
				return null;
			}
			const parsedMagnet = parseMagnet(details.magnetURI);
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
				source: "1337x",
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
		logScraperWarning("1337x", "no results", {
			baseTitle,
			query,
			fallbackQuery,
		});
	}

	return { streams };
};
