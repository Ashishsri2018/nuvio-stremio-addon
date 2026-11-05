import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses defaults", () => {
    const config = loadConfig({});
    expect(config.source).toBe("eclipsia/nuvio-plugin");
    expect(config.branch).toBe("main");
    expect(config.updateIntervalHours).toBe(24);
    expect(config.proxyEnabled).toBe(true);
    expect(config.scraperSettings).toEqual({});
    expect(config.cacheDir).toContain("nuvio-addon");
    expect(config.pinnedSha).toBeNull();
    expect(config.bundledDir).toBeNull();
  });

  it("resolves a bundled snapshot directory and accepts SHA-256 pins", () => {
    const sha = "a".repeat(64);
    const config = loadConfig({
      NUVIO_BUNDLED_DIR: "snapshot",
      NUVIO_SHA: sha,
    });
    expect(config.bundledDir).toBe(path.resolve("snapshot"));
    expect(config.pinnedSha).toBe(sha);
  });

  it("parses scraper settings and lists", () => {
    const config = loadConfig({
      SCRAPER_SETTINGS_JSON: JSON.stringify({
        jyniq: { minSeconds: "900" },
        mavonyx: { res_2160p: true },
      }),
      DISABLED_SCRAPERS: "noctyx, kethrax,noctyx",
      PROXY_ENABLED: "false",
      NUVIO_UPDATE_INTERVAL_HOURS: "24",
    });
    expect(config.scraperSettings.jyniq).toEqual({ minSeconds: "900" });
    expect(config.disabledScrapers.sort()).toEqual(["kethrax", "noctyx"]);
    expect(config.proxyEnabled).toBe(false);
  });

  it("rejects invalid settings JSON", () => {
    expect(() => loadConfig({ SCRAPER_SETTINGS_JSON: "[]" })).toThrow(ConfigError);
    expect(() => loadConfig({ SCRAPER_SETTINGS_JSON: "{bad" })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ SCRAPER_SETTINGS_JSON: JSON.stringify({ demo: "x" }) }),
    ).toThrow(ConfigError);
  });

  it("rejects invalid source, sha, and intervals", () => {
    expect(() => loadConfig({ NUVIO_SOURCE: "not-a-repo" })).toThrow(ConfigError);
    expect(() => loadConfig({ NUVIO_SHA: "xyz" })).toThrow(ConfigError);
    expect(() => loadConfig({ NUVIO_UPDATE_INTERVAL_HOURS: "0" })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ SCRAPER_CONCURRENCY: "99" })).toThrow(ConfigError);
  });
});
