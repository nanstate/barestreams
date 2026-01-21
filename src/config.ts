export type AppConfig = {
	redisUrl: string | null;
	eztvUrls: string[];
	ytsUrls: string[];
	tgxUrls: string[];
	pirateBayUrls: string[];
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
	if (eztvUrls.length === 0) {
		throw new Error("EZTV_URL must contain at least one URL");
	}

	const ytsRaw = process.env.YTS_URL || "";
	const ytsUrls = parseUrls(ytsRaw);
	if (ytsUrls.length === 0) {
		throw new Error("YTS_URL must contain at least one URL");
	}

	const tgxRaw = process.env.TGX_URL || "";
	const tgxUrls = parseUrls(tgxRaw);
	if (tgxUrls.length === 0) {
		throw new Error("TGX_URL must contain at least one URL");
	}

	const pirateBayRaw =
		process.env.PIRATEBAY_URL || "https://thepiratebay.org";
	const pirateBayUrls = parseUrls(pirateBayRaw);
	if (pirateBayUrls.length === 0) {
		throw new Error("PIRATEBAY_URL must contain at least one URL");
	}

	const x1337xRaw = process.env.X1337X_URL || "https://1337x.to";
	const x1337xUrls = parseUrls(x1337xRaw);
	if (x1337xUrls.length === 0) {
		throw new Error("X1337X_URL must contain at least one URL");
	}

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
		pirateBayUrls,
		x1337xUrls,
		flareSolverrSessions,
		flareSolverrSessionRefreshMs,
		flareSolverrUrl,
	};
};

export const config: AppConfig = loadConfig();
