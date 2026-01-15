import { getTitleBasics } from "../imdb/index.js";
import type { ParsedStremioId } from "../parsing/stremioId.js";

export const isSeriesTitleType = (titleType?: string): boolean => {
  if (!titleType) {
    return false;
  }
  const normalized = titleType.toLowerCase();
  return normalized === "tvseries" || normalized === "tvminiseries" || normalized === "tvepisode";
};

export const normalizeQuery = (value: string): string => {
  return value
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

export const formatEpisodeSuffix = (season?: number, episode?: number): string | null => {
  if (!season || !episode) {
    return null;
  }
  const seasonStr = season.toString().padStart(2, "0");
  const episodeStr = episode.toString().padStart(2, "0");
  return `S${seasonStr}E${episodeStr}`;
};

export const parseEpisodeFromText = (
  text?: string
): {
  season: number;
  episode: number;
} | null => {
  if (!text) {
    return null;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  const match =
    normalized.match(/S(?:eason)?\s*0?(\d{1,2})\s*E(?:pisode)?\s*0?(\d{1,2})/i) ??
    normalized.match(/S(\d{1,2})\s*E(\d{1,2})/i) ??
    normalized.match(/(\d{1,2})x(\d{1,2})/i);
  if (!match) {
    return null;
  }
  const season = Number(match[1]);
  const episode = Number(match[2]);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) {
    return null;
  }
  return { season, episode };
};

export const matchesEpisode = (name: string | undefined, season?: number, episode?: number): boolean => {
  if (!season || !episode) {
    return true;
  }
  const parsed = parseEpisodeFromText(name);
  if (!parsed) {
    return false;
  }
  return parsed.season === season && parsed.episode === episode;
};

export const buildQueries = async (
  parsed: ParsedStremioId
): Promise<{ baseTitle: string; query: string; episodeSuffix: string | null }> => {
  const basics = await getTitleBasics(parsed.baseId);
  const baseTitle = basics?.primaryTitle || basics?.originalTitle || parsed.baseId;
  const episodeSuffix = formatEpisodeSuffix(parsed.season, parsed.episode);
  const isSeries = isSeriesTitleType(basics?.titleType) || Boolean(episodeSuffix);

  if (isSeries && episodeSuffix) {
    return { baseTitle, query: normalizeQuery(`${baseTitle} ${episodeSuffix}`), episodeSuffix };
  }
  return { baseTitle, query: normalizeQuery(baseTitle), episodeSuffix: null };
};
