import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	closeRedis,
	getCache,
	initRedis,
	setCache,
} from "../src/cache/redis.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
let redisAvailable = false;

describe("redis cache", () => {
	beforeAll(async () => {
		try {
			await initRedis(REDIS_URL);
			redisAvailable = true;
		} catch {
			redisAvailable = false;
		}
	});

	afterAll(async () => {
		await closeRedis();
	});

	const itWithRedis = () => (redisAvailable ? it : it.skip);

	itWithRedis()("sets and gets a value", async () => {
		const key = `test:key:${Date.now()}`;
		await setCache(key, "hello", 10);
		const value = await getCache(key);
		expect(value).toBe("hello");
	});
});
