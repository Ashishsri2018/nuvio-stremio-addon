import { describe, expect, it } from "vitest";
import { ProviderMetrics, percentile } from "../src/nuvio/metrics.js";

describe("percentile", () => {
  it("returns null without samples", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([], 95)).toBeNull();
  });

  it("uses nearest-rank percentiles", () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(samples, 50)).toBe(50);
    expect(percentile(samples, 95)).toBe(95);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([7], 50)).toBe(7);
  });
});

describe("ProviderMetrics", () => {
  it("counts outcomes per provider", () => {
    const metrics = new ProviderMetrics();
    metrics.record({ id: "alpha", ok: true, streams: 2, latencyMs: 10 });
    metrics.record({ id: "alpha", ok: true, streams: 0, latencyMs: 20 });
    metrics.record({
      id: "alpha",
      ok: false,
      streams: 0,
      latencyMs: 30,
      error: "error",
    });
    metrics.record({
      id: "alpha",
      ok: false,
      streams: 0,
      latencyMs: 40,
      error: "timeout",
    });
    metrics.record({
      id: "alpha",
      ok: false,
      streams: 0,
      latencyMs: 0,
      error: "deadline",
    });

    expect(metrics.report().alpha).toEqual({
      calls: 4,
      ok: 2,
      responded: 1,
      empty: 1,
      errors: 1,
      timeouts: 1,
      skipped: 1,
      successRate: 0.5,
      p50Ms: 20,
      p95Ms: 40,
    });
  });

  it("omits providers that were only skipped and sorts ids", () => {
    const metrics = new ProviderMetrics();
    metrics.record({
      id: "skippedonly",
      ok: false,
      streams: 0,
      latencyMs: 0,
      error: "deadline",
    });
    metrics.record({ id: "beta", ok: true, streams: 1, latencyMs: 5 });
    metrics.record({ id: "alpha", ok: true, streams: 1, latencyMs: 5 });

    expect(Object.keys(metrics.report())).toEqual(["alpha", "beta"]);
  });

  it("keeps only the most recent latency samples", () => {
    const metrics = new ProviderMetrics(3);
    for (const latencyMs of [5, 10, 100, 200]) {
      metrics.record({ id: "alpha", ok: true, streams: 1, latencyMs });
    }
    const stats = metrics.report().alpha;
    expect(stats?.calls).toBe(4);
    expect(stats?.p50Ms).toBe(100);
    expect(stats?.p95Ms).toBe(200);
  });

  it("rounds success rates", () => {
    const metrics = new ProviderMetrics();
    metrics.record({ id: "alpha", ok: true, streams: 1, latencyMs: 5 });
    metrics.record({ id: "alpha", ok: true, streams: 1, latencyMs: 5 });
    metrics.record({
      id: "alpha",
      ok: false,
      streams: 0,
      latencyMs: 5,
      error: "error",
    });
    expect(metrics.report().alpha?.successRate).toBe(0.667);
  });
});
