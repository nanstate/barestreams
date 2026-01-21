import { describe, expect, it } from "vitest";
import { parseStremioId } from "../src/parsing/stremioId.js";

describe("parseStremioId", () => {
	it("parses valid movie id", () => {
		expect(parseStremioId("tt123")).toEqual({ baseId: "tt123" });
	});

	it("parses valid episode id", () => {
		expect(parseStremioId("tt123:1:2")).toEqual({
			baseId: "tt123",
			season: 1,
			episode: 2,
		});
	});

	it("rejects invalid base id", () => {
		expect(() => parseStremioId("123")).toThrow(/Invalid base id/);
	});

	it("rejects invalid season or episode", () => {
		expect(() => parseStremioId("tt123:0:1")).toThrow(/Invalid season/);
		expect(() => parseStremioId("tt123:-1:1")).toThrow(/Invalid season/);
		expect(() => parseStremioId("tt123:1:0")).toThrow(/Invalid episode/);
		expect(() => parseStremioId("tt123:1:-2")).toThrow(/Invalid episode/);
		expect(() => parseStremioId("tt123:one:2")).toThrow(/Invalid season/);
		expect(() => parseStremioId("tt123:1:two")).toThrow(/Invalid episode/);
	});

	it("rejects invalid segment count", () => {
		expect(() => parseStremioId("tt123:1")).toThrow(
			/Invalid id segment count/,
		);
		expect(() => parseStremioId("tt123:1:2:3")).toThrow(
			/Invalid id segment count/,
		);
	});
});
