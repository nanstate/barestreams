import { createClient, type RedisClientType } from "redis";
import { config } from "../config.js";

const CACHE_TTL_SECONDS = 86400; // 24 hours

let client: RedisClientType | null = null;

export const initRedis = async (): Promise<RedisClientType | null> => {
	if (client) {
		return client;
	}

	if (!config.redisUrl) {
		return null;
	}

	client = createClient({ url: config.redisUrl });
	client.on("error", (err) => {
		console.error("Redis error:", err);
	});
	await client.connect();
	return client;
};

export const closeRedis = async (): Promise<void> => {
	if (!client) {
		return;
	}

	await client.quit();
	client = null;
};

export const getCache = async (key: string): Promise<string | null> => {
	if (!client) {
		return null;
	}

	return client.get(key);
};

export const setCache = async (
	key: string,
	value: string,
): Promise<void> => {
	if (!client) {
		return;
	}

	await client.set(key, value, { EX: CACHE_TTL_SECONDS });
};
