import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

const importTrackerModule = async () => {
	vi.resetModules();
	return import("../src/trackers/index.js");
};

afterEach(async () => {
	process.env = { ...ORIGINAL_ENV };
	process.chdir(ORIGINAL_CWD);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("trackers service", () => {
	it("falls back to the first mirror and caches the tracker list", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "barestreams-"));
		process.chdir(tempDir);
		process.env.USE_TRACKERSLIST = "true";
		process.env.CUSTOM_TRACKERS = "udp://custom.example:80/announce";

		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 500 }))
			.mockResolvedValueOnce(
				new Response(
					[
						"udp://one.example:80/announce",
						"udp://two.example:80/announce",
					].join("\n"),
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		const trackers = await importTrackerModule();
		await trackers.ensureTrackers();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(trackers.getTrackersToAppend()).toEqual([
			"udp://one.example:80/announce",
			"udp://two.example:80/announce",
			"udp://custom.example:80/announce",
		]);

		const cacheFile = path.join(tempDir, "data", "trackers", "trackers_best.txt");
		expect(await readFile(cacheFile, "utf8")).toContain(
			"udp://one.example:80/announce",
		);

		await rm(tempDir, { recursive: true, force: true });
	});

	it("loads custom trackers from a file on disk", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "barestreams-"));
		process.chdir(tempDir);
		process.env.USE_TRACKERSLIST = "true";
		const customFile = path.join(tempDir, "custom-trackers.txt");
		await writeFile(
			customFile,
			[
				"",
				"udp://custom-one.example:80/announce",
				"udp://custom-two.example:80/announce",
			].join("\n"),
		);
		process.env.CUSTOM_TRACKERS = customFile;

		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>().mockResolvedValue(
				new Response("udp://built-in.example:80/announce\n"),
			),
		);

		const trackers = await importTrackerModule();
		await trackers.ensureTrackers();

		expect(trackers.getTrackersToAppend()).toEqual([
			"udp://built-in.example:80/announce",
			"udp://custom-one.example:80/announce",
			"udp://custom-two.example:80/announce",
		]);

		await rm(tempDir, { recursive: true, force: true });
	});

	it("uses the cached tracker file when startup refresh fails", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "barestreams-"));
		process.chdir(tempDir);
		process.env.USE_TRACKERSLIST = "true";
		const trackerDir = path.join(tempDir, "data", "trackers");
		await mkdir(trackerDir, { recursive: true });
		await writeFile(
			path.join(trackerDir, "trackers_best.txt"),
			"udp://cached.example:80/announce\n",
		);
		await utimes(
			path.join(trackerDir, "trackers_best.txt"),
			new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
			new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
		);

		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 })),
		);

		const trackers = await importTrackerModule();
		await trackers.ensureTrackers();

		expect(trackers.getTrackersToAppend()).toEqual([
			"udp://cached.example:80/announce",
		]);

		await rm(tempDir, { recursive: true, force: true });
	});

	it("appends trackers to info hash and magnet streams without duplicates", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "barestreams-"));
		process.chdir(tempDir);
		process.env.USE_TRACKERSLIST = "true";

		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>().mockResolvedValue(
				new Response(
					[
						"udp://one.example:80/announce",
						"udp://two.example:80/announce",
					].join("\n"),
				),
			),
		);

		const trackers = await importTrackerModule();
		await trackers.ensureTrackers();

		expect(
			trackers.appendTrackersToStream({
				infoHash: "abcdef0123456789abcdef0123456789abcdef01",
				sources: [
					"tracker:udp://one.example:80/announce",
					"tracker:udp://existing.example:80/announce",
				],
			}),
		).toEqual({
			infoHash: "abcdef0123456789abcdef0123456789abcdef01",
			sources: [
				"tracker:udp://one.example:80/announce",
				"tracker:udp://existing.example:80/announce",
				"tracker:udp://two.example:80/announce",
			],
		});

		const magnetStream = trackers.appendTrackersToStream({
			url: "magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&tr=udp%3A%2F%2Fone.example%3A80%2Fannounce",
		});
		expect(magnetStream.url).toContain("udp%3A%2F%2Ftwo.example%3A80%2Fannounce");
		expect(magnetStream.url).toContain("udp%3A%2F%2Fone.example%3A80%2Fannounce");
		expect(magnetStream.sources).toEqual([
			"tracker:udp://one.example:80/announce",
			"tracker:udp://two.example:80/announce",
		]);

		await rm(tempDir, { recursive: true, force: true });
	});
});
