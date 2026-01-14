export type AppConfig = {
  redisUrl?: string;
  eztvUrls: string[];
  ytsUrls: string[];
  tgxUrls: string[];
  pirateBayUrls: string[];
};

const parseUrls = (raw: string): string[] =>
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

export const loadConfig = (): AppConfig => {
  const redisUrl = process.env.REDIS_URL;
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

  const pirateBayRaw = process.env.PIRATEBAY_URL || "https://thepiratebay.org";
  const pirateBayUrls = parseUrls(pirateBayRaw);
  if (pirateBayUrls.length === 0) {
    throw new Error("PIRATEBAY_URL must contain at least one URL");
  }

  return { redisUrl: redisUrl || undefined, eztvUrls, ytsUrls, tgxUrls, pirateBayUrls };
};
