const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const flareSolverrUrl = process.env.FLARESOLVERR_URL ?? "http://localhost:8191";
const flareSolverrSessions: string[] = [];
let flareSolverrSessionIndex = 0;
let flareSolverrSessionInitAttempted = false;

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

export const initFlareSolverrSessions = async (options?: {
	count?: number;
	prefix?: string;
	timeoutMs?: number;
	warmupUrls?: string[];
}): Promise<void> => {
	if (!flareSolverrUrl || flareSolverrSessionInitAttempted) {
		return;
	}
	flareSolverrSessionInitAttempted = true;
	const count = options?.count ?? 5;
	const prefix = options?.prefix ?? "lazy-1337x";
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const warmupUrl = options?.warmupUrls?.[0];
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
	if (warmupUrl && flareSolverrSessions.length > 0) {
		await Promise.all(
			flareSolverrSessions.map((session) =>
				fetchTextViaFlareSolverr(warmupUrl, timeoutMs, session),
			),
		);
	}
};

export const fetchJson = async <T>(
	url: string,
	options?: FetchOptions,
): Promise<T | null> => {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (options?.useFlareSolverr) {
		const session = options.useFlareSolverrSessionPool
			? getNextFlareSolverrSession()
			: undefined;
		const text = await fetchTextViaFlareSolverr(url, timeoutMs, session);
		if (!text) {
			return null;
		}
		try {
			return JSON.parse(text) as T;
		} catch {
			return null;
		}
	}
	const response = await fetchWithTimeout(url, timeoutMs);
	if (!response) {
		return null;
	}
	try {
		return (await response.json()) as T;
	} catch {
		return null;
	}
};

export const fetchText = async (
	url: string,
	options?: FetchOptions,
): Promise<string | null> => {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (options?.useFlareSolverr) {
		const session = options.useFlareSolverrSessionPool
			? getNextFlareSolverrSession()
			: undefined;
		return fetchTextViaFlareSolverr(url, timeoutMs, session);
	}
	const response = await fetchWithTimeout(url, timeoutMs);
	if (!response) {
		return null;
	}
	try {
		return await response.text();
	} catch {
		return null;
	}
};
