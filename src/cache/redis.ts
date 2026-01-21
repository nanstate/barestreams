import { createClient, type RedisClientType } from "redis";

let client: RedisClientType | null = null;

export const initRedis = async (
	redisUrl?: string,
): Promise<RedisClientType | null> => {
	if (!redisUrl) {
		return null;
	}

	if (client) {
		return client;
	}

	client = createClient({ url: redisUrl });
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
	ttlSeconds: number,
): Promise<void> => {
	if (!client) {
		return;
	}

	await client.set(key, value, { EX: ttlSeconds });
};
