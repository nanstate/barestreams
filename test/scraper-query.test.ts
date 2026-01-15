import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/imdb/index.js", () => ({
  getTitleBasics: vi.fn()
}));

import { getTitleBasics } from "../src/imdb/index.js";
import type { ParsedStremioId } from "../src/parsing/stremioId.js";
import {
  buildQueries,
  formatEpisodeSuffix,
  isSeriesTitleType,
  matchesEpisode,
  normalizeQuery,
  parseEpisodeFromText
} from "../src/scrapers/query.js";

const mockedGetTitleBasics = vi.mocked(getTitleBasics);

describe("scraper query helpers", () => {
  beforeEach(() => {
    mockedGetTitleBasics.mockReset();
  });

  it("formats episode suffixes with padding", () => {
    expect(formatEpisodeSuffix(1, 2)).toBe("S01E02");
    expect(formatEpisodeSuffix()).toBeNull();
  });

  it("parses episode identifiers from text", () => {
    expect(parseEpisodeFromText("Season 2 Episode 3")).toEqual({ season: 2, episode: 3 });
    expect(parseEpisodeFromText("S01E04")).toEqual({ season: 1, episode: 4 });
    expect(parseEpisodeFromText("1x09")).toEqual({ season: 1, episode: 9 });
    expect(parseEpisodeFromText("no episode")).toBeNull();
  });

  it("matches episodes only when requested", () => {
    expect(matchesEpisode(undefined, 1, 2)).toBe(false);
    expect(matchesEpisode("Show S01E02", 1, 2)).toBe(true);
    expect(matchesEpisode("Show S01E03", 1, 2)).toBe(false);
    expect(matchesEpisode("Anything")).toBe(true);
  });

  it("normalizes queries by stripping punctuation", () => {
    expect(normalizeQuery("Hello, World!")).toBe("Hello World");
  });

  it("detects series title types", () => {
    expect(isSeriesTitleType("tvSeries")).toBe(true);
    expect(isSeriesTitleType("movie")).toBe(false);
  });

  it("builds series queries with episode suffix", async () => {
    mockedGetTitleBasics.mockResolvedValue({
      primaryTitle: "My Show",
      originalTitle: "My Show",
      titleType: "tvSeries"
    });
    const parsed: ParsedStremioId = {
      baseId: "tt123",
      season: 1,
      episode: 2
    };
    await expect(buildQueries(parsed)).resolves.toEqual({
      baseTitle: "My Show",
      query: "My Show S01E02",
      episodeSuffix: "S01E02"
    });
  });

  it("builds movie queries without episode suffix", async () => {
    mockedGetTitleBasics.mockResolvedValue({
      primaryTitle: "A Movie",
      originalTitle: "A Movie",
      titleType: "movie"
    });
    const parsed: ParsedStremioId = {
      baseId: "tt999",
      season: undefined,
      episode: undefined
    };
    await expect(buildQueries(parsed)).resolves.toEqual({
      baseTitle: "A Movie",
      query: "A Movie",
      episodeSuffix: null
    });
  });
});
