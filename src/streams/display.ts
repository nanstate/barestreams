export type StreamDisplayOptions = {
  imdbTitle: string;
  season?: number;
  episode?: number;
  torrentName?: string;
  quality?: string | null;
  source?: string | null;
  seeders?: number;
  sizeBytes?: number | null;
  sizeLabel?: string | null;
};

const QUALITY_REGEX = /\b(2160p|1080p|720p|480p|4k|uhd)\b/i;

export const extractQualityHint = (text: string): string | null => {
  const match = text.match(QUALITY_REGEX);
  if (!match) {
    return null;
  }
  const quality = match[1].toLowerCase();
  if (quality === "4k" || quality === "uhd") {
    return "2160p";
  }
  return quality;
};

const formatEpisode = (season?: number, episode?: number): string | null => {
  if (!season || !episode) {
    return null;
  }
  return `Season ${season} Episode ${episode}`;
};

const buildTitlePattern = (title: string): RegExp | null => {
  const trimmed = title.trim();
  if (!trimmed) {
    return null;
  }
  const pattern = trimmed.replace(/[^a-z0-9]+/gi, "[^a-z0-9]+");
  if (!pattern) {
    return null;
  }
  return new RegExp(pattern, "i");
};

const buildTorrentSlug = (torrentName?: string, imdbTitle?: string): string | null => {
  if (!torrentName) {
    return null;
  }
  let stripped = torrentName;
  if (imdbTitle) {
    const pattern = buildTitlePattern(imdbTitle);
    if (pattern) {
      stripped = stripped.replace(pattern, "");
    }
  }
  stripped = stripped.replace(/\bS\d{1,2}E\d{1,2}\b/i, "");
  const cleaned = stripped
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "")
    .trim();
  return cleaned ? cleaned : null;
};

const formatBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
};

const formatInfoLine = (seeders?: number, sizeBytes?: number | null, sizeLabel?: string | null): string => {
  const seederCount = typeof seeders === "number" && seeders > 0 ? seeders : 0;
  let sizeText: string | null = null;
  if (typeof sizeBytes === "number" && sizeBytes > 0) {
    sizeText = formatBytes(sizeBytes);
  } else if (sizeLabel) {
    sizeText = sizeLabel.trim();
  }
  if (!sizeText) {
    sizeText = "Unknown size";
  }
  return `🌱 ${seederCount} • 💾 ${sizeText}`;
};

const resolveQuality = (options: StreamDisplayOptions): string => {
  const hint =
    extractQualityHint(options.torrentName ?? "") ?? extractQualityHint(options.quality ?? "") ?? null;
  return hint ?? "480p";
};

const formatQualityLabel = (quality: string): string => {
  const normalized = quality.trim().toLowerCase();
  if (normalized === "2160p" || normalized === "4k" || normalized === "uhd") {
    return "4K";
  }
  return normalized;
};

export const formatStreamDisplay = (options: StreamDisplayOptions): {
  name: string;
  title: string;
  description?: string;
} => {
  const imdbTitle = options.imdbTitle?.trim() || "Unknown title";
  const qualityLabel = formatQualityLabel(resolveQuality(options));
  const name = options.source?.trim() || "Stream";
  const title = `Watch ${qualityLabel}`;
  const episodeLine = formatEpisode(options.season, options.episode);
  const slugLine =
    buildTorrentSlug(options.torrentName, imdbTitle) || options.quality?.trim() || "Unknown release";
  const sourceLabel = options.source?.trim() || "Unknown";
  const slugDisplay = `${slugLine} (${sourceLabel})`;
  const infoLine = formatInfoLine(options.seeders, options.sizeBytes ?? null, options.sizeLabel ?? null);
  const lines = [imdbTitle, episodeLine, slugDisplay, infoLine].filter((line): line is string =>
    Boolean(line)
  );

  return {
    name,
    title,
    description: lines.join("\n")
  };
};
