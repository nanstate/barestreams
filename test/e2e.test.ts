import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAddonInterface } from "../src/addon.js";
import { config } from "../src/config.js";
import { initFlareSolverrSessions } from "../src/scrapers/http.js";

vi.mock("../src/imdb/index.js", () => {
	return {
		getTitleBasics: async (tconst: string) => {
			if (tconst === "tt10872600") {
				return {
					tconst,
					titleType: "movie",
					primaryTitle: "Spider-Man: No Way Home",
					originalTitle: "Spider-Man: No Way Home",
					isAdult: false,
					startYear: 2021,
					endYear: null,
					runtimeMinutes: 120,
					genres: ["Action"],
				};
			}
			if (tconst === "tt5834204") {
				return {
					tconst,
					titleType: "tvSeries",
					primaryTitle: "The Handmaid's Tale",
					originalTitle: "The Handmaid's Tale",
					isAdult: false,
					startYear: 2017,
					endYear: null,
					runtimeMinutes: null,
					genres: ["Drama"],
				};
			}
			return null;
		},
		ensureImdbDatasets: async () => {},
	};
});

const testConfig = config;
const itWithConfig =
	testConfig.ytsUrls.length > 0 &&
	testConfig.tgxUrls.length > 0 &&
	testConfig.eztvUrls.length > 0
		? it
		: it.skip;

describe("addon end-to-end", () => {
	beforeAll(async () => {
		await initFlareSolverrSessions();
	}, 60000);

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	itWithConfig(
		"returns movie streams and caches results (tt10872600)",
		async () => {
			const addon = createAddonInterface();
			const result = await addon.get("stream", "movie", "tt10872600");

			expect(result.streams.length).toBeGreaterThan(0);
			const hasYts = result.streams.some((stream) =>
				stream.description?.includes("🔗 YTS"),
			);
			const hasTgx = result.streams.some((stream) =>
				stream.description?.includes("🔗 TGX"),
			);
			expect(hasYts || hasTgx).toBe(true);

			if (testConfig.redisUrl) {
				const cached = await addon.get("stream", "movie", "tt10872600");
				expect(cached.streams.length).toBe(result.streams.length);
			}
		},
		30000,
	);

	itWithConfig(
		"returns series streams for S02E03 (tt5834204)",
		async () => {
			const addon = createAddonInterface();
			const result = await addon.get("stream", "series", "tt5834204:2:3");

			expect(
				result.streams.some((stream) =>
					stream.description?.includes("🔗 EZTV"),
				),
			).toBe(true);
			expect(result.streams.length).toBeGreaterThan(0);
		},
		60000,
	);
});
