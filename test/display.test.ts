import { describe, expect, it } from "vitest";
import { formatStreamDisplay } from "../src/streams/display.js";

describe("formatStreamDisplay", () => {
  it("formats series display text with slug, source, and info", () => {
    const display = formatStreamDisplay({
      imdbTitle: "The Handmaid's Tale",
      season: 6,
      episode: 7,
      torrentName: "The.Handmaid's.Tale.S06E07.1080p.WEB.h264-ETHEL",
      seeders: 231,
      sizeLabel: "1.4 GB",
      source: "EZTV"
    });

    console.log(display);

    expect(display.name).toBe("EZTV");
    expect(display.title).toBe("Watch 1080p");
    expect(display.description).toBe(
      "The Handmaid's Tale\nSeason 6 Episode 7\n1080p WEB h264-ETHEL (EZTV)\n🌱 231 • 💾 1.4 GB"
    );
  });

  it("defaults missing quality to 480p", () => {
    const display = formatStreamDisplay({
      imdbTitle: "Some Movie",
      torrentName: "Some.Movie.WEB.x264-GROUP",
      sizeLabel: "900 MB",
      source: "TGX"
    });

    console.log(display);

    expect(display.title).toBe("Watch 480p");
    expect(display.description).toBe(
      "Some Movie\nWEB x264-GROUP (TGX)\n🌱 0 • 💾 900 MB"
    );
  });
});
