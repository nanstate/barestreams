import { afterAll, describe, expect, it } from "vitest";
import { closeRedis, getCache, initRedis, setCache } from "../src/cache/redis.js";

describe("redis cache", () => {
  afterAll(async () => {
    await closeRedis();
  });

  it("sets and gets a value", async () => {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("REDIS_URL is required for cache test");
    }

    await initRedis(redisUrl);
    const key = `test:key:${Date.now()}`;
    await setCache(key, "hello", 10);
    const value = await getCache(key);
    expect(value).toBe("hello");
  });
});
