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
