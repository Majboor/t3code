import type { GatewayDailyActivity } from "../../environments/primary";

/** Percent used, clamped to [0, 100] — never shown alongside the raw counts it's computed from. */
export function percentUsed(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

/** "resets in 3h 42m" / "resets in 12d" — never the raw timestamp or token counts. */
export function formatResetsIn(resetsAt: string | null, nowMs: number = Date.now()): string {
  if (resetsAt === null) return "starts on your next request";
  const diffMs = new Date(resetsAt).getTime() - nowMs;
  if (diffMs <= 0) return "resets shortly";
  const totalMinutes = Math.ceil(diffMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  if (days >= 1) return `resets in ${days}d`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 1) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

export interface HeatmapCell {
  readonly day: string;
  readonly requests: number;
  readonly level: 0 | 1 | 2 | 3 | 4;
}

/**
 * Buckets each day's request count into 5 intensity levels (0 = none) using
 * quantiles of the observed non-zero days — a GitHub-contributions-style
 * scale that adapts to how active this particular account actually is,
 * rather than fixed thresholds that would look empty for a light user or
 * saturated for a heavy one.
 */
export function buildHeatmapCells(daily: ReadonlyArray<GatewayDailyActivity>): HeatmapCell[] {
  const byDay = new Map(daily.map((d) => [d.day, d.requests]));
  const nonZero = daily.map((d) => d.requests).filter((n) => n > 0).sort((a, b) => a - b);
  const thresholds = [0.25, 0.5, 0.75].map((q) => nonZero[Math.floor(q * (nonZero.length - 1))] ?? 0);

  const levelFor = (requests: number): 0 | 1 | 2 | 3 | 4 => {
    if (requests <= 0) return 0;
    if (requests <= thresholds[0]!) return 1;
    if (requests <= thresholds[1]!) return 2;
    if (requests <= thresholds[2]!) return 3;
    return 4;
  };

  const today = new Date();
  const cells: HeatmapCell[] = [];
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    const requests = byDay.get(day) ?? 0;
    cells.push({ day, requests, level: levelFor(requests) });
  }
  return cells;
}

export function formatCompactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
