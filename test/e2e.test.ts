import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAddonInterface } from "../src/addon.js";
import type { AppConfig } from "../src/config.js";

vi.mock("../src/cache/redis.js", () => {
  const store = new Map<string, string>();
  return {
    getCache: async (key: string) => store.get(key) ?? null,
    setCache: async (key: string, value: string) => {
      store.set(key, value);
    },
    initRedis: async () => ({}),
    closeRedis: async () => {},
    __resetCache: () => {
      store.clear();
    }
  };
});

vi.mock("../src/imdb/index.js", () => {
  return {
    getTitleBasics: async (tconst: string) => {
      if (tconst === "tt10872600") {
        return {
          tconst,
          titleType: "movie",
          primaryTitle: "MovieTitle",
          originalTitle: "MovieTitle",
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
          primaryTitle: "SeriesTitle",
          originalTitle: "SeriesTitle",
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

const config: AppConfig = {
  redisUrl: "redis://unused",
  ytsUrls: ["https://yts.example"],
  tgxUrls: ["https://tgx.example"],
  eztvUrls: ["https://eztv.example"]
};

const buildSearchHtml = (name: string, href: string): string => `
<table class="table-list-wrap">
  <tbody>
    <tr>
      <td><div class="tt-name"><a href="${href}">${name}</a></div></td>
      <td>uploader</td>
      <td>1.4 GB</td>
      <td>123</td>
      <td>45</td>
    </tr>
  </tbody>
</table>
`;

const buildDetailHtml = (magnet: string): string =>
  `<html><body><a href="${magnet}">Magnet</a></body></html>`;

const setupFetch = () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url);

    if (parsed.hostname === "yts.example" && parsed.pathname.endsWith("/list_movies.json")) {
      const body = {
        status: "ok",
        data: {
          movies: [
            {
              imdb_code: "tt10872600",
              title: "MovieTitle",
              title_long: "MovieTitle (2021)",
              torrents: [
                {
                  hash: "YTSHASH",
                  quality: "1080p",
                  type: "web",
                  seeds: 120,
                  size_bytes: 1_073_741_824
                }
              ]
            }
          ]
        }
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (parsed.hostname === "eztv.example" && parsed.pathname.endsWith("/api/get-torrents")) {
      const body = {
        torrents: [
          {
            title: "SeriesTitle S02E03",
            magnet_url: "magnet:?xt=urn:btih:EZTVHASH",
            seeds: 50,
            size_bytes: 2_147_483_648,
            season: 2,
            episode: 3
          },
          {
            title: "SeriesTitle S02E02",
            magnet_url: "magnet:?xt=urn:btih:OTHER",
            season: 2,
            episode: 2
          }
        ]
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (parsed.hostname === "tgx.example" && parsed.pathname === "/lmsearch") {
      const query = parsed.searchParams.get("q") ?? "";
      const page = parsed.searchParams.get("page") ?? "1";
      if (page !== "1") {
        return new Response('<table class="table-list-wrap"><tbody></tbody></table>', {
          status: 200,
          headers: { "Content-Type": "text/html" }
        });
      }
      if (query.includes("S02E03")) {
        return new Response(buildSearchHtml("SeriesTitle S02E03 1080p", "/torrent/series-123"), {
          status: 200,
          headers: { "Content-Type": "text/html" }
        });
      }
      return new Response(buildSearchHtml("MovieTitle 1080p", "/torrent/movie-123"), {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }

    if (parsed.hostname === "tgx.example" && parsed.pathname === "/torrent/series-123") {
      return new Response(buildDetailHtml("magnet:?xt=urn:btih:TGXSERIES"), {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }

    if (parsed.hostname === "tgx.example" && parsed.pathname === "/torrent/movie-123") {
      return new Response(buildDetailHtml("magnet:?xt=urn:btih:TGXMOVIE"), {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }

    return new Response("not found", { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("addon end-to-end", () => {
  beforeEach(async () => {
    const cache = await import("../src/cache/redis.js");
    (cache as { __resetCache?: () => void }).__resetCache?.();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns movie streams and caches results (tt10872600)", async () => {
    const fetchMock = setupFetch();
    const addon = createAddonInterface(config);
    const result = await addon.get("stream", "movie", "tt10872600");

    expect(result.streams.length).toBeGreaterThan(0);
    expect(result.streams.some((stream) => stream.name === "YTS")).toBe(true);
    expect(result.streams.some((stream) => stream.name === "TGx")).toBe(true);

    fetchMock.mockClear();
    const cached = await addon.get("stream", "movie", "tt10872600");
    expect(cached.streams.length).toBe(result.streams.length);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns series streams for S02E03 (tt5834204)", async () => {
    setupFetch();
    const addon = createAddonInterface(config);
    const result = await addon.get("stream", "series", "tt5834204:2:3");

    expect(result.streams.some((stream) => stream.name === "EZTV")).toBe(true);
    expect(result.streams.some((stream) => stream.name === "TGx")).toBe(true);
    expect(result.streams.some((stream) => stream.url.includes("EZTVHASH"))).toBe(true);
  });
});
