import * as http from "node:http";
import { createAddonInterface } from "./addon.js";
import { loadConfig } from "./config.js";
import { initRedis } from "./cache/redis.js";
import { ensureImdbDatasets } from "./imdb/index.js";
import { BadRequestError } from "./types.js";

const PORT = 80;

const sendJson = (res: http.ServerResponse, statusCode: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
};

const start = async (): Promise<void> => {
  const config = loadConfig();
  await initRedis(config.redisUrl);
  await ensureImdbDatasets();
  const addonInterface = createAddonInterface(config);

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      sendJson(res, 400, { error: "Bad request" });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*"
      });
      res.end();
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    if (path === "/manifest.json") {
      console.info(`Manifest requested: ${req.method} ${path}`);
      sendJson(res, 200, addonInterface.manifest);
      return;
    }

    if (path.startsWith("/stream/")) {
      const parts = path.split("/").filter(Boolean);
      if (parts.length !== 3 || !parts[2].endsWith(".json")) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      const type = parts[1];
      const id = parts[2].slice(0, -5);

      try {
        const result = await addonInterface.get("stream", type, id);
        sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof BadRequestError) {
          sendJson(res, 400, { error: err.message });
          return;
        }

        console.error(err);
        sendJson(res, 500, { error: "Internal server error" });
      }
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  server.listen(PORT);
};

start().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
