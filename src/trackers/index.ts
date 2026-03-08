import { existsSync, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { config } from "../config.js";
import {
	appendTrackersToMagnetUri,
	extractTrackersFromSources,
} from "../parsing/magnet.js";
import type { Stream } from "../types.js";

const TRACKER_LIST_URLS = [
	"https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt",
	"https://ngosang.github.io/trackerslist/trackers_best.txt",
	"https://cdn.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best.txt",
];
const TRACKER_DATA_DIR = path.resolve(process.cwd(), "data", "trackers");
const TRACKER_CACHE_FILE = path.join(TRACKER_DATA_DIR, "trackers_best.txt");
const STALE_MS = 24 * 60 * 60 * 1000;

let currentTrackers: string[] = [];
let refreshPromise: Promise<void> | null = null;
let refreshInterval: NodeJS.Timeout | null = null;

const parseTrackerCsv = (raw: string): string[] =>
	raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);

export const normalizeTracker = (value: string): string | null => {
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith("#")) {
		return null;
	}
	try {
		return new URL(trimmed).toString();
	} catch {
		return null;
	}
};

export const parseTrackerLines = (raw: string): string[] =>
	raw
		.split(/\r?\n/)
		.map((entry) => normalizeTracker(entry))
		.filter((entry): entry is string => Boolean(entry));

export const dedupeTrackers = (trackers: string[]): string[] => {
	const deduped = new Set<string>();
	for (const tracker of trackers) {
		const normalized = normalizeTracker(tracker);
		if (normalized) {
			deduped.add(normalized);
		}
	}
	return Array.from(deduped);
};

const readTrackersFromCache = async (): Promise<string[] | null> => {
	try {
		const contents = await readFile(TRACKER_CACHE_FILE, "utf8");
		return parseTrackerLines(contents);
	} catch {
		return null;
	}
};

const isCacheStale = async (): Promise<boolean> => {
	try {
		const info = await stat(TRACKER_CACHE_FILE);
		return Date.now() - info.mtimeMs > STALE_MS;
	} catch {
		return true;
	}
};

const writeBuiltInTrackers = async (trackers: string[]): Promise<void> => {
	await mkdir(TRACKER_DATA_DIR, { recursive: true });
	const tempFile = `${TRACKER_CACHE_FILE}.tmp`;
	const text = `${trackers.join("\n")}\n`;
	const body = Readable.from([text]);
	await pipeline(body, createWriteStream(tempFile));
	await rm(TRACKER_CACHE_FILE, { force: true });
	await rename(tempFile, TRACKER_CACHE_FILE);
};

const fetchTrackerList = async (url: string): Promise<string[] | null> => {
	try {
		const response = await fetch(url);
		if (!response.ok || !response.body) {
			return null;
		}
		const destination = `${TRACKER_CACHE_FILE}.download`;
		const body = response.body as unknown as WebReadableStream<Uint8Array>;
		await mkdir(TRACKER_DATA_DIR, { recursive: true });
		await pipeline(Readable.fromWeb(body), createWriteStream(destination));
		const contents = await readFile(destination, "utf8");
		await rm(destination, { force: true });
		return parseTrackerLines(contents);
	} catch {
		return null;
	}
};

const fetchBuiltInTrackers = async (): Promise<string[]> => {
	for (const url of TRACKER_LIST_URLS) {
		const trackers = await fetchTrackerList(url);
		if (trackers && trackers.length > 0) {
			return trackers;
		}
	}
	throw new Error("Failed to download trackers list");
};

const loadCustomTrackers = async (): Promise<string[]> => {
	const source = config.customTrackerSource;
	if (!source) {
		return [];
	}
	if (existsSync(source)) {
		try {
			const contents = await readFile(source, "utf8");
			return parseTrackerLines(contents);
		} catch {
			return [];
		}
	}
	return dedupeTrackers(parseTrackerCsv(source));
};

const updateCurrentTrackers = async (builtInTrackers: string[]): Promise<void> => {
	const customTrackers = await loadCustomTrackers();
	currentTrackers = dedupeTrackers([...builtInTrackers, ...customTrackers]);
};

const refreshTrackers = async (): Promise<void> => {
	const cached = await readTrackersFromCache();
	if (cached && cached.length > 0) {
		await updateCurrentTrackers(cached);
	}

	try {
		const builtInTrackers = await fetchBuiltInTrackers();
		await writeBuiltInTrackers(builtInTrackers);
		await updateCurrentTrackers(builtInTrackers);
	} catch (error) {
		if (!cached || cached.length === 0) {
			throw error;
		}
	}
};

const refreshTrackersInBackground = (): void => {
	if (refreshPromise) {
		return;
	}
	refreshPromise = refreshTrackers()
		.catch((error) => {
			console.error("Failed to refresh tracker list:", error);
		})
		.finally(() => {
			refreshPromise = null;
		});
};

export const ensureTrackers = async (): Promise<void> => {
	if (!config.useTrackerslist) {
		currentTrackers = [];
		return;
	}

	await mkdir(TRACKER_DATA_DIR, { recursive: true });

	const cached = await readTrackersFromCache();
	if (cached && cached.length > 0) {
		await updateCurrentTrackers(cached);
		if (await isCacheStale()) {
			setImmediate(() => {
				refreshTrackersInBackground();
			});
		}
	} else {
		await refreshTrackers();
	}

	if (!refreshInterval) {
		refreshInterval = setInterval(() => {
			refreshTrackersInBackground();
		}, STALE_MS);
		refreshInterval.unref();
	}
};

export const getTrackersToAppend = (): string[] => {
	if (!config.useTrackerslist) {
		return [];
	}
	return currentTrackers;
};

const addTrackerSources = (
	sources: string[] | undefined,
	trackers: string[],
): string[] => {
	const passthroughSources = (sources ?? []).filter(
		(source) => !source.startsWith("tracker:"),
	);
	const existingTrackers = extractTrackersFromSources(sources ?? []);
	const merged = dedupeTrackers([...existingTrackers, ...trackers]);
	return [
		...passthroughSources,
		...merged.map((tracker) => `tracker:${tracker}`),
	];
};

export const appendTrackersToStream = (stream: Stream): Stream => {
	const trackers = getTrackersToAppend();
	if (trackers.length === 0) {
		return stream;
	}
	if (stream.infoHash) {
		return {
			...stream,
			sources: addTrackerSources(stream.sources, trackers),
		};
	}
	if (stream.url?.startsWith("magnet:?")) {
		const magnetUri = appendTrackersToMagnetUri(stream.url, trackers);
		if (!magnetUri) {
			return stream;
		}
		const parsed = new URL(magnetUri);
		const magnetTrackers = parsed.searchParams.getAll("tr");
		return {
			...stream,
			url: magnetUri,
			sources: addTrackerSources(stream.sources, magnetTrackers),
		};
	}
	return stream;
};
