export type ProviderError = "timeout" | "error" | "non_array" | "deadline";

export interface ProviderOutcome {
  id: string;
  ok: boolean;
  streams: number;
  latencyMs: number;
  error?: ProviderError;
}

export interface ProviderStats {
  calls: number;
  ok: number;
  responded: number;
  empty: number;
  errors: number;
  timeouts: number;
  skipped: number;
  successRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

export type ProviderStatsReport = Record<string, ProviderStats>;

interface ProviderState {
  calls: number;
  ok: number;
  responded: number;
  empty: number;
  errors: number;
  timeouts: number;
  skipped: number;
  latencies: number[];
}

const DEFAULT_CAPACITY = 100;

export function percentile(
  samples: readonly number[],
  p: 50 | 95,
): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] as number;
}

export class ProviderMetrics {
  private readonly capacity: number;
  private readonly providers = new Map<string, ProviderState>();

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  record(outcome: ProviderOutcome): void {
    const state = this.stateFor(outcome.id);
    if (outcome.error === "deadline") {
      state.skipped += 1;
      return;
    }

    state.calls += 1;
    if (outcome.ok) {
      state.ok += 1;
      if (outcome.streams > 0) state.responded += 1;
      else state.empty += 1;
    } else if (outcome.error === "timeout") {
      state.timeouts += 1;
    } else {
      state.errors += 1;
    }

    state.latencies.push(outcome.latencyMs);
    if (state.latencies.length > this.capacity) state.latencies.shift();
  }

  report(): ProviderStatsReport {
    const report: ProviderStatsReport = {};
    for (const id of [...this.providers.keys()].sort()) {
      const state = this.providers.get(id) as ProviderState;
      if (state.calls === 0) continue;
      report[id] = {
        calls: state.calls,
        ok: state.ok,
        responded: state.responded,
        empty: state.empty,
        errors: state.errors,
        timeouts: state.timeouts,
        skipped: state.skipped,
        successRate: Math.round((state.ok / state.calls) * 1000) / 1000,
        p50Ms: percentile(state.latencies, 50),
        p95Ms: percentile(state.latencies, 95),
      };
    }
    return report;
  }

  private stateFor(id: string): ProviderState {
    let state = this.providers.get(id);
    if (!state) {
      state = {
        calls: 0,
        ok: 0,
        responded: 0,
        empty: 0,
        errors: 0,
        timeouts: 0,
        skipped: 0,
        latencies: [],
      };
      this.providers.set(id, state);
    }
    return state;
  }
}
