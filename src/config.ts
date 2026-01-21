export type AppConfig = {
	redisUrl: string | null;
	eztvUrls: string[];
	ytsUrls: string[];
	tgxUrls: string[];
	apiBayUrls: string[];
	x1337xUrls: string[];
	flareSolverrSessions: number;
	flareSolverrSessionRefreshMs: number;
	flareSolverrUrl: string | null;
};

const parseUrls = (raw: string): string[] =>
	raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);

export const loadConfig = (): AppConfig => {
	const eztvRaw = process.env.EZTV_URL || "";
	const eztvUrls = parseUrls(eztvRaw);

	const ytsRaw = process.env.YTS_URL || "";
	const ytsUrls = parseUrls(ytsRaw);

	const tgxRaw = process.env.TGX_URL || "";
	const tgxUrls = parseUrls(tgxRaw);

	const apiBayRaw = process.env.APIBAY_URL ?? "";
	const apiBayUrls = parseUrls(apiBayRaw);

	const x1337xRaw = process.env.X1337X_URL ?? "";
	const x1337xUrls = parseUrls(x1337xRaw);

	const flareSolverrRaw = process.env.FLARESOLVERR_SESSIONS || "10";
	const flareSolverrSessions = Math.max(
		1,
		Number.parseInt(flareSolverrRaw, 10) || 10,
	);
	const flareSolverrRefreshRaw =
		process.env.FLARESOLVERR_SESSION_REFRESH_MS || "3600000";
	const flareSolverrSessionRefreshMs = Math.max(
		0,
		Number.parseInt(flareSolverrRefreshRaw, 10) || 0,
	);

	const flareSolverrUrlRaw = process.env.FLARESOLVERR_URL?.trim() ?? "";
	const flareSolverrUrl = flareSolverrUrlRaw ? flareSolverrUrlRaw : null;

	const redisUrlRaw = process.env.REDIS_URL?.trim() ?? "";
	const redisUrl = redisUrlRaw ? redisUrlRaw : null;

	return {
		redisUrl,
		eztvUrls,
		ytsUrls,
		tgxUrls,
		apiBayUrls,
		x1337xUrls,
		flareSolverrSessions,
		flareSolverrSessionRefreshMs,
		flareSolverrUrl,
	};
};

export const config: AppConfig = loadConfig();
