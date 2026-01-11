export type AppConfig = {
  redisUrl: string;
};

export const loadConfig = (): AppConfig => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required");
  }

  return { redisUrl };
};
