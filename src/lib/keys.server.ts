/**
 * Image provider access control.
 *
 * NINE keys, ONE model: every render goes to Agnes AI `agnes-image-2.5-flash`
 * through one of up to nine server-only keys (AGNES_API_KEY_1 … AGNES_API_KEY_9,
 * with AGNES_API_KEY accepted as a first key too). Keys are read only here, on
 * the server, and are never sent to the browser or written into the codebase.
 *
 * The free tier allows 20 requests per minute PER KEY, so each key owns its own
 * hard 20 RPM sliding-window gate plus a small concurrency cap. Every image
 * request in the process passes through `withImageKey`, which picks the first
 * key with room, so no key can ever exceed its limit no matter how many lanes
 * the page runs.
 */

/** Requests allowed per rolling minute, per key (provider limit). */
export const IMAGE_RPM = 20;
/** Rolling window length. */
const WINDOW_MS = 60_000;
/** Safety margin so clock drift never pushes a request over the edge. */
const SPACING_MS = Math.ceil(WINDOW_MS / IMAGE_RPM) + 100; // ~3.1s between starts per key

/**
 * How many renders may be in flight at once per key. A render can take tens of
 * seconds; more than this in parallel buys nothing once 20 RPM is the ceiling.
 */
export const PER_KEY_CONCURRENCY = 4;

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

const lanes = new Map<string, Lane>();

function lane(key: string): Lane {
  let l = lanes.get(key);
  if (!l) {
    l = { starts: [], inFlight: 0, lastStart: 0 };
    lanes.set(key, l);
  }
  return l;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Milliseconds to wait before this key may start another request. 0 = go now. */
function waitFor(l: Lane, now: number): number {
  l.starts = l.starts.filter((t) => now - t < WINDOW_MS);
  if (l.inFlight >= PER_KEY_CONCURRENCY) return 200;
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

/**
 * Leases a rate-limit slot on the least busy key for the duration of `fn` and
 * hands it that key. Keeps the historical signature (`slot`, `attempt`) so
 * callers are unchanged.
 */
export async function withImageKey<T>(
  _slot: number,
  _attempt: number,
  fn: (key: string, keyIndex: number) => Promise<T>,
): Promise<T> {
  const keys = agnesKeys();
  let chosen = -1;
  for (;;) {
    const now = Date.now();
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < keys.length; i++) {
      const idx = (cursor + i) % keys.length;
      const wait = waitFor(lane(keys[idx] as string), now);
      if (wait <= 0) {
        chosen = idx;
        break;
      }
      if (wait < best) best = wait;
    }
    if (chosen >= 0) break;
    await sleep(Math.min(best, 1_000));
  }
  cursor = (chosen + 1) % keys.length;
  const key = keys[chosen] as string;
  const l = lane(key);
  const now = Date.now();
  l.lastStart = now;
  l.starts.push(now);
  l.inFlight++;
  try {
    return await fn(key, chosen);
  } finally {
    l.inFlight--;
  }
}
