import { config } from "../config.js";
import {
	EZTV_IMDB_VARIANTS,
	EZTV_PAGE_CONCURRENCY,
	EZTV_SEARCH_LINK_LIMIT,
	PIRATEBAY_CATEGORY_COUNT,
	TGX_DETAIL_LIMIT,
} from "./limits.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export enum ScraperKey {
	X1337x = "x1337x",
	Eztv = "eztv",
	Tgx = "tgx",
	Tpb = "tpb",
	Yts = "yts",
}

type FlareSolverrPool = {
	key: ScraperKey;
	sessionCount: number;
	sessions: string[];
	index: number;
	warmupUrl: string;
	refreshInFlight: boolean;
	useAlways: boolean;
};

let flareSolverrUrl: string | null = null;
const flareSolverrPools = new Map<ScraperKey, FlareSolverrPool>();
let flareSolverrSessionInitAttempted = false;
let flareSolverrRefreshTimer: NodeJS.Timeout | null = null;

const logFetchWarning = (
	url: string,
	details?: Record<string, unknown>,
): void => {
	const suffix = details ? ` ${JSON.stringify(details)}` : "";
	console.warn(`[scraper] error response ${url}${suffix}`);
};

type FetchOptions = {
	timeoutMs?: number;
	scraper: ScraperKey;
	signal: AbortSignal | null;
	useFlareSolverr?: boolean;
	useFlareSolverrSessionPool?: boolean;
};

type FlareSolverrResponse = {
	status: string;
	session?: string;
	solution?: {
		response: string;
		status: number;
	};
};

type FlareSolverrPoolConfig = {
	key: ScraperKey;
	sessionCount: number;
	warmupUrl: string;
};

export const normalizeBaseUrl = (baseUrl: string): string =>
	baseUrl.replace(/\/+$/, "");

const createAbortController = (
	timeoutMs: number,
	signal: AbortSignal | null,
): { controller: AbortController; cleanup: () => void } => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	let detach: (() => void) | null = null;
	if (signal) {
		const onAbort = () => controller.abort();
		if (signal.aborted) {
			controller.abort();
		} else {
			signal.addEventListener("abort", onAbort);
			detach = () => signal.removeEventListener("abort", onAbort);
		}
	}
	return {
		controller,
		cleanup: () => {
			clearTimeout(timeout);
			if (detach) {
				detach();
			}
		},
	};
};

const fetchResponseWithTimeout = async (
	url: string,
	timeoutMs: number,
	signal: AbortSignal | null,
): Promise<Response | null> => {
	const { controller, cleanup } = createAbortController(timeoutMs, signal);
	try {
		const response = await fetch(url, {
			headers: { "User-Agent": USER_AGENT },
			signal: controller.signal,
		});
		return response;
	} catch {
		return null;
	} finally {
		cleanup();
	}
};

const fetchTextViaFlareSolverr = async (
	url: string,
	timeoutMs: number,
	signal: AbortSignal | null,
	session?: string,
): Promise<string | null> => {
	if (!flareSolverrUrl) {
		return null;
	}
	const { controller, cleanup } = createAbortController(timeoutMs, signal);
	try {
		const response = await fetch(`${flareSolverrUrl}/v1`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				cmd: "request.get",
				url,
				maxTimeout: timeoutMs,
				session,
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			logFetchWarning(url, { status: response.status, source: "flaresolverr" });
			return null;
		}
		const payload = (await response.json()) as FlareSolverrResponse;
		if (payload.status !== "ok" || !payload.solution?.response) {
			logFetchWarning(url, {
				source: "flaresolverr",
				status: payload.status,
			});
			return null;
		}
		if (payload.solution.status < 200 || payload.solution.status >= 300) {
			logFetchWarning(url, {
				source: "flaresolverr",
				status: payload.solution.status,
			});
			return null;
		}
		return payload.solution.response;
	} catch (e) {
		if (!signal?.aborted) {
			logFetchWarning(url, {
				error: (e as Error).message,
				source: "flaresolverr",
			});
		}
		return null;
	} finally {
		cleanup();
	}
};

const createFlareSolverrSession = async (
	session: string,
	timeoutMs: number,
): Promise<string | null> => {
	if (!flareSolverrUrl) {
		return null;
	}
	const { controller, cleanup } = createAbortController(timeoutMs, null);
	try {
		const response = await fetch(`${flareSolverrUrl}/v1`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				cmd: "sessions.create",
				session,
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			logFetchWarning(flareSolverrUrl, { status: response.status });
			return null;
		}
		const payload = (await response.json()) as FlareSolverrResponse;
		if (payload.status !== "ok") {
			return null;
		}
		return payload.session ?? session;
	} catch {
		return null;
	} finally {
		cleanup();
	}
};

const destroyFlareSolverrSession = async (
	session: string,
	timeoutMs: number,
): Promise<boolean> => {
	if (!flareSolverrUrl) {
		return false;
	}
	const { controller, cleanup } = createAbortController(timeoutMs, null);
	try {
		const response = await fetch(`${flareSolverrUrl}/v1`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				cmd: "sessions.destroy",
				session,
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			logFetchWarning(flareSolverrUrl, { status: response.status });
			return false;
		}
		const payload = (await response.json()) as FlareSolverrResponse;
		return payload.status === "ok";
	} catch {
		return false;
	} finally {
		cleanup();
	}
};

const getNextFlareSolverrSession = (pool: FlareSolverrPool): string | undefined => {
	if (pool.sessions.length === 0) {
		return undefined;
	}
	const session = pool.sessions[pool.index % pool.sessions.length];
	pool.index += 1;
	return session;
};

const getFlareSolverrPool = (
	scraper: ScraperKey,
): FlareSolverrPool | undefined => flareSolverrPools.get(scraper);

const shouldUseFlareSolverr = (
	options: FetchOptions,
	pool: FlareSolverrPool | undefined,
): boolean => {
	if (!flareSolverrUrl) {
		return false;
	}
	return Boolean(options.useFlareSolverr || pool?.useAlways);
};

const resolveFlareSolverrSession = (
	options: FetchOptions,
	pool: FlareSolverrPool | undefined,
): string | undefined => {
	if (!pool || pool.sessions.length === 0) {
		return undefined;
	}
	const usePool = options.useFlareSolverrSessionPool !== false;
	if (!usePool) {
		return undefined;
	}
	return getNextFlareSolverrSession(pool);
};

const markFlareSolverrRequired = (pool: FlareSolverrPool): void => {
	pool.useAlways = true;
};

const createFlareSolverrSessionsForPool = async (
	pool: FlareSolverrPool,
	timeoutMs: number,
): Promise<void> => {
	if (pool.sessionCount <= 0 || pool.sessions.length > 0) {
		return;
	}
	const sessions = Array.from(
		{ length: pool.sessionCount },
		(_, index) => `fs-${pool.key}-${index + 1}`,
	);
	const created = await Promise.all(
		sessions.map((session) => createFlareSolverrSession(session, timeoutMs)),
	);
	for (const session of created) {
		if (session) {
			pool.sessions.push(session);
		}
	}
};

const enableFlareSolverrForPool = async (
	pool: FlareSolverrPool,
	timeoutMs: number,
): Promise<void> => {
	markFlareSolverrRequired(pool);
	await createFlareSolverrSessionsForPool(pool, timeoutMs);
	await warmupFlareSolverrPool(pool, timeoutMs);
};

const attemptFlareSolverrFallback = async (
	url: string,
	timeoutMs: number,
	options: FetchOptions,
	pool: FlareSolverrPool | undefined,
): Promise<string | null> => {
	if (!flareSolverrUrl) {
		return null;
	}
	if (pool && !pool.useAlways) {
		await enableFlareSolverrForPool(pool, timeoutMs);
	}
	const session = resolveFlareSolverrSession(options, pool);
	const text = await fetchTextViaFlareSolverr(
		url,
		timeoutMs,
		options.signal,
		session,
	);
	if (text) {
		if (pool) {
			markFlareSolverrRequired(pool);
		}
	}
	return text;
};

const refreshFlareSolverrPool = async (
	pool: FlareSolverrPool,
	options: { timeoutMs: number },
): Promise<void> => {
	if (pool.refreshInFlight || pool.sessions.length === 0 || !pool.useAlways) {
		return;
	}
	pool.refreshInFlight = true;
	try {
		for (let index = 0; index < pool.sessions.length; index += 1) {
			const session = pool.sessions[index];
			const warmed = await fetchTextViaFlareSolverr(
				pool.warmupUrl,
				options.timeoutMs,
				null,
				session,
			);
			if (warmed) {
				continue;
			}
			await destroyFlareSolverrSession(session, options.timeoutMs);
			const recreated = await createFlareSolverrSession(
				session,
				options.timeoutMs,
			);
			if (!recreated) {
				continue;
			}
			pool.sessions[index] = recreated;
			await fetchTextViaFlareSolverr(
				pool.warmupUrl,
				options.timeoutMs,
				null,
				recreated,
			);
		}
	} finally {
		pool.refreshInFlight = false;
	}
};

const warmupFlareSolverrPool = async (
	pool: FlareSolverrPool,
	timeoutMs: number,
): Promise<void> => {
	if (pool.sessions.length === 0 || !pool.useAlways) {
		return;
	}
	await Promise.all(
		pool.sessions.map((session) =>
			fetchTextViaFlareSolverr(pool.warmupUrl, timeoutMs, null, session),
		),
	);
};

const resolveYtsWarmupUrl = (baseUrl: string): string => {
	try {
		const url = new URL(baseUrl);
		const apiIndex = url.pathname.indexOf("/api");
		if (apiIndex >= 0) {
			const prefix = url.pathname.slice(0, apiIndex);
			url.pathname = prefix || "/";
		}
		url.search = "";
		url.hash = "";
		return normalizeBaseUrl(url.toString());
	} catch {
		return normalizeBaseUrl(baseUrl);
	}
};

const resolveApiBayWarmupUrl = (baseUrl: string): string => {
	const normalized = normalizeBaseUrl(baseUrl);
	const params = new URLSearchParams({ q: "matrix", cat: "0" });
	return `${normalized}/q.php?${params.toString()}`;
};

const buildFlareSolverrPoolConfigs = (): FlareSolverrPoolConfig[] => {
	const configs: FlareSolverrPoolConfig[] = [];
	const sessionCap = config.flareSolverrSessions;
	const applySessionCap = (count: number): number =>
		sessionCap > 0 ? Math.min(sessionCap, count) : 0;
	if (config.x1337xUrls.length > 0) {
		configs.push({
			key: ScraperKey.X1337x,
			sessionCount: applySessionCap(config.flareSolverrSessions),
			warmupUrl: normalizeBaseUrl(config.x1337xUrls[0]),
		});
	}
	if (config.eztvUrls.length > 0) {
		const baseCount = config.eztvUrls.length;
		const sessionCount = applySessionCap(
			Math.max(
				EZTV_PAGE_CONCURRENCY * EZTV_IMDB_VARIANTS * baseCount,
				EZTV_SEARCH_LINK_LIMIT * baseCount,
			),
		);
		configs.push({
			key: ScraperKey.Eztv,
			sessionCount,
			warmupUrl: normalizeBaseUrl(config.eztvUrls[0]),
		});
	}
	if (config.tgxUrls.length > 0) {
		configs.push({
			key: ScraperKey.Tgx,
			sessionCount: applySessionCap(TGX_DETAIL_LIMIT),
			warmupUrl: normalizeBaseUrl(config.tgxUrls[0]),
		});
	}
	if (config.apiBayUrls.length > 0) {
		const baseCount = config.apiBayUrls.length;
		configs.push({
			key: ScraperKey.Tpb,
			sessionCount: applySessionCap(
				Math.max(1, baseCount * PIRATEBAY_CATEGORY_COUNT),
			),
			warmupUrl: resolveApiBayWarmupUrl(config.apiBayUrls[0]),
		});
	}
	if (config.ytsUrls.length > 0) {
		configs.push({
			key: ScraperKey.Yts,
			sessionCount: applySessionCap(Math.max(1, config.ytsUrls.length)),
			warmupUrl: resolveYtsWarmupUrl(config.ytsUrls[0]),
		});
	}
	return configs;
};

const initFlareSolverrPool = async (
	poolConfig: FlareSolverrPoolConfig,
): Promise<void> => {
	const pool: FlareSolverrPool = {
		key: poolConfig.key,
		sessionCount: poolConfig.sessionCount,
		sessions: [],
		index: 0,
		warmupUrl: poolConfig.warmupUrl,
		refreshInFlight: false,
		useAlways: false,
	};
	flareSolverrPools.set(poolConfig.key, pool);
	if (poolConfig.sessionCount <= 0) {
		return;
	}
};

const probeScraperFrontPages = async (
	poolConfigs: FlareSolverrPoolConfig[],
	timeoutMs: number,
): Promise<void> => {
	const probes = poolConfigs.map(async (poolConfig) => {
		const response = await fetchResponseWithTimeout(
			poolConfig.warmupUrl,
			timeoutMs,
			null,
		);
		if (!response) {
			return;
		}
		if (response.status !== 401 && response.status !== 403) {
			return;
		}
		const pool = flareSolverrPools.get(poolConfig.key);
		if (!pool) {
			return;
		}
		await enableFlareSolverrForPool(pool, timeoutMs);
		const session = resolveFlareSolverrSession(
			{ scraper: poolConfig.key, signal: null },
			pool,
		);
		const text = await fetchTextViaFlareSolverr(
			poolConfig.warmupUrl,
			timeoutMs,
			null,
			session,
		);
		if (text) {
			markFlareSolverrRequired(pool);
		}
	});
	await Promise.all(probes);
};

export const initFlareSolverrSessions = async (): Promise<void> => {
	if (flareSolverrSessionInitAttempted) {
		return;
	}
	flareSolverrUrl = config.flareSolverrUrl;
	flareSolverrSessionInitAttempted = true;
	if (!flareSolverrUrl) {
		return;
	}
	const poolConfigs = buildFlareSolverrPoolConfigs();
	if (poolConfigs.length === 0) {
		return;
	}
	const timeoutMs = DEFAULT_TIMEOUT_MS;
	await Promise.all(
		poolConfigs.map((poolConfig) => initFlareSolverrPool(poolConfig)),
	);
	await probeScraperFrontPages(poolConfigs, timeoutMs);
	if (config.flareSolverrSessionRefreshMs > 0 && !flareSolverrRefreshTimer) {
		flareSolverrRefreshTimer = setInterval(() => {
			for (const pool of flareSolverrPools.values()) {
				void refreshFlareSolverrPool(pool, { timeoutMs });
			}
		}, config.flareSolverrSessionRefreshMs);
	}
};

const fetchTextWithFallback = async (
	url: string,
	options: FetchOptions,
): Promise<string | null> => {
	if (options.signal?.aborted) {
		return null;
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pool = getFlareSolverrPool(options.scraper);
	const useFlareSolverr = shouldUseFlareSolverr(options, pool);
	if (useFlareSolverr) {
		const session = resolveFlareSolverrSession(options, pool);
		const text = await fetchTextViaFlareSolverr(
			url,
			timeoutMs,
			options.signal,
			session,
		);
		if (!text) {
			return null;
		}
		return text;
	}
	const response = await fetchResponseWithTimeout(
		url,
		timeoutMs,
		options.signal,
	);
	if (!response) {
		if (!options.signal?.aborted) {
			logFetchWarning(url, { error: "no-response" });
		}
		return null;
	}
	if (response.ok) {
		try {
			return await response.text();
		} catch {
			logFetchWarning(url, { error: "read-failed" });
			return null;
		}
	}
	if (response.status === 401 || response.status === 403) {
		const text = await attemptFlareSolverrFallback(
			url,
			timeoutMs,
			options,
			pool,
		);
		if (text) {
			return text;
		}
	}
	logFetchWarning(url, { status: response.status });
	return null;
};

const extractJsonPayload = (text: string): string | null => {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return trimmed;
	}
	const match = trimmed.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
	if (!match) {
		return null;
	}
	const preText = match[1].trim();
	if (!preText || (!preText.startsWith("{") && !preText.startsWith("["))) {
		return null;
	}
	return preText;
};

export const fetchJson = async <T>(
	url: string,
	options: FetchOptions,
): Promise<T | null> => {
	const text = await fetchTextWithFallback(url, options);
	if (!text) {
		return null;
	}
	const payloadText = extractJsonPayload(text);
	if (!payloadText) {
		logFetchWarning(url, { error: "non-json-response" });
		return null;
	}
	try {
		return JSON.parse(payloadText) as T;
	} catch (e) {
		logFetchWarning(url, { error: (e as Error).message });
		console.warn('[scraper] response was not json:', text);
		return null;
	}
};

export const fetchText = async (
	url: string,
	options: FetchOptions,
): Promise<string | null> => fetchTextWithFallback(url, options);
