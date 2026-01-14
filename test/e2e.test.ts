import { afterEach, describe, expect, it, vi } from "vitest";
import { createAddonInterface } from "../src/addon.js";
import type { AppConfig } from "../src/config.js";

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
          genres: ["Action"]
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
          genres: ["Drama"]
        };
      }
      return null;
    },
    ensureImdbDatasets: async () => {}
  };
});

const loadTestConfig = (): AppConfig | null => {
  const redisUrl = process.env.REDIS_URL;
  const ytsUrl = process.env.YTS_URL || "https://yts.lt";
  const tgxUrl = process.env.TGX_URL || "https://torrentgalaxy.hair";
  const eztvUrl = process.env.EZTV_URL || "https://eztv.re";
  const pirateBayUrl = process.env.PIRATEBAY_URL || "https://thepiratebay.org";

  return {
    redisUrl: redisUrl || undefined,
    ytsUrls: [ytsUrl],
    tgxUrls: [tgxUrl],
    eztvUrls: [eztvUrl],
    pirateBayUrls: [pirateBayUrl]
  };
};

const testConfig = loadTestConfig();
const itWithConfig = testConfig ? it : it.skip;

describe("addon end-to-end", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  itWithConfig("returns movie streams and caches results (tt10872600)", async () => {
    const addon = createAddonInterface(testConfig!);
    const result = await addon.get("stream", "movie", "tt10872600");

    expect(result.streams.length).toBeGreaterThan(0);
    expect(result.streams.some((stream) => stream.description?.includes("(YTS)"))).toBe(true);
    expect(result.streams.some((stream) => stream.description?.includes("(TGX)"))).toBe(true);

    if (testConfig?.redisUrl) {
      const cached = await addon.get("stream", "movie", "tt10872600");
      expect(cached.streams.length).toBe(result.streams.length);
    }
  }, 30000);

  itWithConfig("returns series streams for S02E03 (tt5834204)", async () => {
    const addon = createAddonInterface(testConfig!);
    const result = await addon.get("stream", "series", "tt5834204:2:3");

    expect(result.streams.some((stream) => stream.description?.includes("(EZTV)"))).toBe(true);
    expect(result.streams.length).toBeGreaterThan(0);
  }, 30000);
});
