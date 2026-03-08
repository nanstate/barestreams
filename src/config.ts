export type AppConfig = {
	redisUrl: string | null;
	redisTtlHours: number | null;
	eztvUrls: string[];
	ytsUrls: string[];
	tgxUrls: string[];
	apiBayUrls: string[];
	x1337xUrls: string[];
	katUrls: string[];
	flareSolverrSessions: number;
	flareSolverrSessionRefreshMs: number;
	flareSolverrUrl: string | null;
	maxRequestWaitSeconds: number | null;
	useTrackerslist: boolean;
	customTrackerSource: string | null;
};

const parseUrls = (raw: string): string[] =>
	raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);

const parsePositiveInt = (raw: string): number | null => {
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseBoolean = (raw: string): boolean | null => {
	const normalized = raw.trim().toLowerCase();
	if (normalized === "true") {
		return true;
	}
	if (normalized === "false") {
		return false;
	}
	return null;
};

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

	const katRaw = process.env.KAT_URL;
	const katUrls = katRaw ? parseUrls(katRaw) : [];

	const flareSolverrRaw = process.env.FLARESOLVERR_SESSIONS || "10";
	const flareSolverrSessions = parsePositiveInt(flareSolverrRaw) ?? 10;
	const flareSolverrRefreshRaw =
		process.env.FLARESOLVERR_SESSION_REFRESH_MS || "3600000";
	const flareSolverrSessionRefreshMs =
		parsePositiveInt(flareSolverrRefreshRaw) ?? 0;

	const flareSolverrUrlRaw = process.env.FLARESOLVERR_URL?.trim() ?? "";
	const flareSolverrUrl = flareSolverrUrlRaw ? flareSolverrUrlRaw : null;

	const redisUrlRaw = process.env.REDIS_URL?.trim() ?? "";
	const redisUrl = redisUrlRaw ? redisUrlRaw : null;

	const redisTtlRaw = process.env.REDIS_TTL_HOURS?.trim() ?? "";
	const redisTtlHours = parsePositiveInt(redisTtlRaw);

	const maxRequestWaitRaw =
		process.env.MAX_REQUEST_WAIT_SECONDS?.trim() ?? "";
	const maxRequestWaitSeconds = parsePositiveInt(maxRequestWaitRaw);

	const useTrackerslistRaw = process.env.USE_TRACKERSLIST?.trim() ?? "";
	const useTrackerslist = parseBoolean(useTrackerslistRaw) ?? true;

	const customTrackerSourceRaw = process.env.CUSTOM_TRACKERS?.trim() ?? "";
	const customTrackerSource = customTrackerSourceRaw || null;

	return {
		redisUrl,
		redisTtlHours,
		eztvUrls,
		ytsUrls,
		tgxUrls,
		apiBayUrls,
		x1337xUrls,
		katUrls,
		flareSolverrSessions,
		flareSolverrSessionRefreshMs,
		flareSolverrUrl,
		maxRequestWaitSeconds,
		useTrackerslist,
		customTrackerSource,
	};
};

export const config: AppConfig = loadConfig();
