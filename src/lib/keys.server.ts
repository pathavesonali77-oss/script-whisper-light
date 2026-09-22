/**
 * Image provider access control.
 *
 * NINE keys, ONE model: every render goes to Agnes AI `agnes-image-2.5-flash`
 * through one of up to nine server-only keys (AGNES_API_KEY_1 … AGNES_API_KEY_9,
 * with AGNES_API_KEY accepted as a first key too). Keys are read only here, on
 * the server, and are never sent to the browser or written into the codebase.
 *
 * Agnes' Cloudflare edge applies the 20 RPM limit to the shared caller, not
 * independently to each credential. Every image request therefore passes
 * through one process-wide, sequential 20 RPM gate. Keys still rotate so an
 * exhausted or invalid credential does not pin every later panel to one key.
 */

/** Requests allowed per rolling minute across the Agnes image service. */
export const IMAGE_RPM = 20;
/** Rolling window length. */
const WINDOW_MS = 60_000;
/** Safety margin so clock drift never pushes a request over the edge. */
const SPACING_MS = Math.ceil(WINDOW_MS / IMAGE_RPM) + 100; // ~3.1s between starts per key

/**
 * Requests may overlap, but only because every start is still spaced ~3.1s
 * apart by the gate below, so the service never sees a burst. Overlapping a
 * few slow renders is what keeps total wall time low.
 */
export const IMAGE_CONCURRENCY = 3;

/** All configured Agnes keys, in order. */
export function agnesKeys(): string[] {
  const names = [
    "AGNES_API_KEY",
    "AGNES_API_KEY_1",
    "AGNES_API_KEY_2",
    "AGNES_API_KEY_3",
    "AGNES_API_KEY_4",
    "AGNES_API_KEY_5",
    "AGNES_API_KEY_6",
    "AGNES_API_KEY_7",
    "AGNES_API_KEY_8",
    "AGNES_API_KEY_9",
  ];
  const seen = new Set<string>();
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) seen.add(v);
  }
  const keys = [...seen];
  if (keys.length === 0) throw new Error("Missing AGNES_API_KEY_1 (Agnes AI image key)");
  return keys;
}

/** First key — kept for callers that only need "a" key. */
export function agnesKey(): string {
  return agnesKeys()[0] as string;
}

type Lane = { starts: number[]; inFlight: number; lastStart: number };

/** Shared by every key because error 1015 is imposed before authentication. */
const providerLane: Lane = { starts: [], inFlight: 0, lastStart: 0 };
let cooldownUntil = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Milliseconds to wait before this key may start another request. 0 = go now. */
function waitFor(l: Lane, now: number): number {
  l.starts = l.starts.filter((t) => now - t < WINDOW_MS);
  if (now < cooldownUntil) return cooldownUntil - now;
  if (l.inFlight >= IMAGE_CONCURRENCY) return 200;
  const sinceLast = now - l.lastStart;
  if (sinceLast < SPACING_MS) return SPACING_MS - sinceLast;
  if (l.starts.length >= IMAGE_RPM) {
    const oldest = l.starts[0] as number;
    return Math.max(50, WINDOW_MS - (now - oldest));
  }
  return 0;
}

/** Round-robin cursor so load spreads evenly across the keys. */
let cursor = 0;

/** Parks every queued request after Agnes/Cloudflare reports 429 or 1015. */
export function reportImageRateLimit(retryAfterMs = WINDOW_MS): void {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + Math.max(SPACING_MS, retryAfterMs));
}

/**
 * Leases the service-wide image slot and hands the request the next key.
 * Keeps the historical signature (`slot`, `attempt`) so callers are unchanged.
 */
export async function withImageKey<T>(
  _slot: number,
  _attempt: number,
  fn: (key: string, keyIndex: number) => Promise<T>,
): Promise<T> {
  const keys = agnesKeys();
  for (;;) {
    const now = Date.now();
    const wait = waitFor(providerLane, now);
    if (wait <= 0) break;
    await sleep(Math.min(wait, 1_000));
  }
  const chosen = cursor;
  cursor = (chosen + 1) % keys.length;
  const key = keys[chosen] as string;
  const now = Date.now();
  providerLane.lastStart = now;
  providerLane.starts.push(now);
  providerLane.inFlight++;
  try {
    return await fn(key, chosen);
  } finally {
    providerLane.inFlight--;
  }
}
