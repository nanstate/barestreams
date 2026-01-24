import { config } from "../config.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
let flareSolverrUrl: string | null = null;
const flareSolverrSessions: string[] = [];
let flareSolverrSessionIndex = 0;
let flareSolverrSessionInitAttempted = false;
let flareSolverrRefreshTimer: NodeJS.Timeout | null = null;
let flareSolverrRefreshInFlight = false;

const logFetchWarning = (url: string): void => {
	console.warn(`[scraper] error response ${url}`);
};

type FetchOptions = {
	timeoutMs?: number;
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

export const normalizeBaseUrl = (baseUrl: string): string =>
	baseUrl.replace(/\/+$/, "");

const fetchWithTimeout = async (
	url: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response | null> => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			headers: { "User-Agent": USER_AGENT },
			signal: controller.signal,
		});
		if (!response.ok) {
			return null;
		}
		return response;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
};

const fetchTextViaFlareSolverr = async (
	url: string,
	timeoutMs: number,
	session?: string,
): Promise<string | null> => {
	if (!flareSolverrUrl) {
		return null;
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
			return null;
		}
		const payload = (await response.json()) as FlareSolverrResponse;
		if (payload.status !== "ok" || !payload.solution?.response) {
			return null;
		}
		if (payload.solution.status < 200 || payload.solution.status >= 300) {
			return null;
		}
		return payload.solution.response;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
};

const createFlareSolverrSession = async (
	session: string,
	timeoutMs: number,
): Promise<string | null> => {
	if (!flareSolverrUrl) {
		return null;
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
		clearTimeout(timeout);
	}
};

const destroyFlareSolverrSession = async (
	session: string,
	timeoutMs: number,
): Promise<boolean> => {
	if (!flareSolverrUrl) {
		return false;
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
			return false;
		}
		const payload = (await response.json()) as FlareSolverrResponse;
		return payload.status === "ok";
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
};

const getNextFlareSolverrSession = (): string | undefined => {
	if (flareSolverrSessions.length === 0) {
		return undefined;
	}
	const session =
		flareSolverrSessions[
			flareSolverrSessionIndex % flareSolverrSessions.length
		];
	flareSolverrSessionIndex += 1;
	return session;
};

const refreshFlareSolverrSessions = async (options: {
	timeoutMs: number;
	warmupUrl: string;
}): Promise<void> => {
	if (flareSolverrRefreshInFlight || flareSolverrSessions.length === 0) {
		return;
	}
	const warmupUrl = options.warmupUrl;
	flareSolverrRefreshInFlight = true;
	try {
		for (let index = 0; index < flareSolverrSessions.length; index += 1) {
			const session = flareSolverrSessions[index];
			const warmed = await fetchTextViaFlareSolverr(
				warmupUrl,
				options.timeoutMs,
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
			flareSolverrSessions[index] = recreated;
			await fetchTextViaFlareSolverr(
				warmupUrl,
				options.timeoutMs,
				recreated,
			);
		}
	} finally {
		flareSolverrRefreshInFlight = false;
	}
};

export const initFlareSolverrSessions = async (): Promise<void> => {
	if (flareSolverrSessionInitAttempted) {
		return;
	}
	flareSolverrUrl = config.flareSolverrUrl;
	if (!flareSolverrUrl) {
		return;
	}
	flareSolverrSessionInitAttempted = true;
	const count = config.flareSolverrSessions;
	const prefix = "fs-1337x";
	const timeoutMs = DEFAULT_TIMEOUT_MS;
	const warmupUrl = config.x1337xUrls[0];
	if (!warmupUrl) {
		throw new Error("FlareSolverr warmup URL required.");
	}
	const sessions = Array.from(
		{ length: count },
		(_, index) => `${prefix}-${index + 1}`,
	);
	const created = await Promise.all(
		sessions.map((session) =>
			createFlareSolverrSession(session, timeoutMs),
		),
	);
	for (const session of created) {
		if (session) {
			flareSolverrSessions.push(session);
		}
	}
	if (flareSolverrSessions.length > 0) {
		await Promise.all(
			flareSolverrSessions.map((session) =>
				fetchTextViaFlareSolverr(warmupUrl, timeoutMs, session),
			),
		);
	}
	if (config.flareSolverrSessionRefreshMs > 0) {
		flareSolverrRefreshTimer = setInterval(() => {
			void refreshFlareSolverrSessions({ timeoutMs, warmupUrl });
		}, config.flareSolverrSessionRefreshMs);
	}
};

export const fetchJson = async <T>(
	url: string,
	options?: FetchOptions,
): Promise<T | null> => {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (options?.useFlareSolverr && flareSolverrUrl) {
		const session = options.useFlareSolverrSessionPool
			? getNextFlareSolverrSession()
			: undefined;
		const text = await fetchTextViaFlareSolverr(url, timeoutMs, session);
		if (!text) {
			logFetchWarning(url);
			return null;
		}
		try {
			return JSON.parse(text) as T;
		} catch {
			logFetchWarning(url);
			return null;
		}
	}
	const response = await fetchWithTimeout(url, timeoutMs);
	if (!response) {
		logFetchWarning(url);
		return null;
	}
	try {
		return (await response.json()) as T;
	} catch {
		logFetchWarning(url);
		return null;
	}
};

export const fetchText = async (
	url: string,
	options?: FetchOptions,
): Promise<string | null> => {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (options?.useFlareSolverr && flareSolverrUrl) {
		const session = options.useFlareSolverrSessionPool
			? getNextFlareSolverrSession()
			: undefined;
		const text = await fetchTextViaFlareSolverr(url, timeoutMs, session);
		if (!text) {
			logFetchWarning(url);
			return null;
		}
		return text;
	}
	const response = await fetchWithTimeout(url, timeoutMs);
	if (!response) {
		logFetchWarning(url);
		return null;
	}
	try {
		return await response.text();
	} catch {
		logFetchWarning(url);
		return null;
	}
};
