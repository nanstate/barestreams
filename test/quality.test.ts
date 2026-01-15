import { describe, expect, it } from "vitest";
import { extractQualityHint } from "../src/streams/quality.js";

describe("extractQualityHint", () => {
  it("normalizes 4k and uhd to 2160p", () => {
    expect(extractQualityHint("Movie 4K HDR")).toBe("2160p");
    expect(extractQualityHint("Movie UHD")).toBe("2160p");
  });

  it("returns null when no quality is present", () => {
    expect(extractQualityHint("Movie Release")).toBeNull();
  });
});
