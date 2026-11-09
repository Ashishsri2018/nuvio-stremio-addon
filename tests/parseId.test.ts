import { describe, expect, it } from "vitest";
import { contentIdOf, parseStreamId } from "../src/addon/parseId.js";

describe("parseStreamId", () => {
  it("parses IMDb movie and series ids", () => {
    expect(parseStreamId("movie", "tt0133093.json")).toEqual({
      type: "movie",
      imdbId: "tt0133093",
    });
    expect(parseStreamId("series", "tt0944947:1:2.json")).toEqual({
      type: "series",
      imdbId: "tt0944947",
      season: 1,
      episode: 2,
    });
    expect(parseStreamId("series", "tt0944947:1")).toEqual({
      type: "series",
      imdbId: "tt0944947",
      season: 1,
    });
  });

  it("parses TMDB movie and series ids", () => {
    expect(parseStreamId("movie", "tmdb:550.json")).toEqual({
      type: "movie",
      tmdbId: 550,
    });
    expect(parseStreamId("series", "tmdb:1399:1:2.json")).toEqual({
      type: "series",
      tmdbId: 1399,
      season: 1,
      episode: 2,
    });
    expect(parseStreamId("series", "tmdb:1399:1")).toEqual({
      type: "series",
      tmdbId: 1399,
      season: 1,
    });
  });

  it("rejects unsupported or malformed ids", () => {
    const invalid: Array<[string, string]> = [
      ["movie", "not-an-id"],
      ["movie", "tt"],
      ["movie", "tt0133093:1:2"],
      ["movie", "tmdb:0"],
      ["movie", "tmdb:abc"],
      ["movie", "tmdb:"],
      ["movie", "tmdb:550:1:2"],
      ["series", "tt0944947"],
      ["series", "tmdb:1399"],
      ["series", "tmdb:1399:0:2"],
      ["series", "tmdb:1399:1:0"],
      ["anime", "tt0944947:1:2"],
    ];
    for (const [type, id] of invalid) {
      expect(parseStreamId(type, id), `${type} ${id}`).toBeNull();
    }
  });
});

describe("contentIdOf", () => {
  it("returns a canonical content id for logs and cache keys", () => {
    expect(contentIdOf({ type: "movie", imdbId: "tt0133093" })).toBe("tt0133093");
    expect(contentIdOf({ type: "movie", tmdbId: 550 })).toBe("tmdb:550");
  });
});
