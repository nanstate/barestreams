export type AppConfig = {
  redisUrl: string;
  eztvUrls: string[];
  ytsUrls: string[];
};

const parseUrls = (raw: string): string[] =>
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

export const loadConfig = (): AppConfig => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required");
  }

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

  return { redisUrl, eztvUrls, ytsUrls };
};
