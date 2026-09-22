/**
 * Image provider access control.
 *
 * NINE keys, ONE model: every render goes to Agnes AI `agnes-image-2.5-flash`
 * through one of up to nine server-only keys (AGNES_API_KEY_1 … AGNES_API_KEY_9,
 * with AGNES_API_KEY accepted as a first key too). Keys are read only here, on
 * the server, and are never sent to the browser or written into the codebase.
 *
 * WHY THIS FILE NO LONGER WAITS
 * -----------------------------
 * The previous version held a per-key "lane" in module memory: a lease, a
 * rolling-minute counter and a 20s spacing rule, with a `for(;;) await sleep()`
 * loop that blocked a request until a lane opened.
 *
 * That works in a single long-lived dev process and fails on live hosting,
 * because live hosting runs each server call in its own short-lived isolate:
 *
 *   - Isolate A's lane map knows nothing about isolate B's, so the "shared"
 *     budget was never actually shared and never actually enforced.
 *   - An isolate torn down mid-request never runs its `finally`, so its lease
 *     leaked. A reused warm isolate then had every lane marked busy by jobs
 *     that no longer existed, and the waiting loop spun forever inside a live
 *     request — the freeze after the first handful of images.
 *
 * Measured against the real provider, nine keys sustain nine parallel renders
 * with no 429 at all, so the elaborate gate was protecting against a limit that
 * does not bite. Key choice is now a pure, instant function of the slot the
 * browser assigns. Nothing here ever blocks; a key that genuinely reports a
 * throttle is skipped for a short while, never waited on.
 */

import { assertActive, registerKillHook } from "./kill-switch.server";

/** Hard provider ceiling per key, per rolling minute (documented, not enforced here). */
export const IMAGE_RPM = 20;

/**
 * How many panels the browser may draw at once. The browser owns this limit
 * because it is the only participant that sees the whole run; the server side
 * cannot, since each call may land in a different isolate.
 */
export const IMAGE_CONCURRENCY = 6;

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

/** Stable first lane for a job, including when every request gets a fresh isolate. */
export function imageKeyStartIndex(slot: number, attempt: number, keyCount: number): number {
  if (keyCount <= 0) return 0;
  return (((slot + attempt) % keyCount) + keyCount) % keyCount;
}

/**
 * Keys that answered with a throttle recently, with the moment they may be
 * tried again. Best-effort only: it is process-local, it is consulted to SKIP a
 * key, and it can never make a request wait. If every key is resting the
 * preferred key is used anyway — a fast 429 that the browser retries is always
 * better than a request that hangs.
 */
const restingUntil = new Map<string, number>();

/**
 * Cloudflare's "error code: 1015" in front of the image provider is an EDGE
 * block on the calling network, not on the credential. Live hosting sends every
 * call from a shared egress address, so once 1015 appears, swapping keys just
 * burns more blocked requests — every key is blocked at the same time. That is
 * why the problem only shows up on the live site and never in the dev sandbox,
 * which has its own address and its own allowance.
 *
 * So a 1015 parks ALL keys for a short while and the next request waits it out
 * instead of hammering through it.
 */
let globalCooldownUntil = 0;

/** Milliseconds every key must stay idle right now (0 when clear). */
export function imageCooldownRemaining(): number {
  return Math.max(0, globalCooldownUntil - Date.now());
}

/** Parks the key that hit 429, and every key when the block is an edge 1015. */
export function reportImageRateLimit(
  key: string,
  retryAfterMs = 15_000,
  edgeBlock = false,
): void {
  const ms = Math.max(1_000, Math.min(90_000, retryAfterMs));
  if (key) restingUntil.set(key, Date.now() + ms);
  if (edgeBlock) globalCooldownUntil = Math.max(globalCooldownUntil, Date.now() + ms);
}

/** Insta Kill: forget every cooldown, nothing is drawing any more. */
export function releaseAllImageKeys(): void {
  restingUntil.clear();
  globalCooldownUntil = 0;
}

registerKillHook(releaseAllImageKeys);

/**
 * Picks a key and runs the request on it — immediately, always.
 *
 * `slot` is assigned by the browser and increments per panel, so consecutive
 * panels land on consecutive keys even when every call runs in its own isolate.
 * `attempt` shifts to the next key on a retry, so a bad credential cannot pin a
 * panel to itself.
 */
export async function withImageKey<T>(
  slot: number,
  attempt: number,
  fn: (key: string, keyIndex: number) => Promise<T>,
): Promise<T> {
  assertActive();
  // Sit out an edge block instead of spending more blocked calls on it. The
  // wait is short and interruptible so a killed run never lingers here.
  for (let waited = 0; waited < 30_000; waited += 250) {
    const left = imageCooldownRemaining();
    if (left <= 0) break;
    assertActive();
    await new Promise((r) => setTimeout(r, Math.min(250, left)));
  }
  const keys = agnesKeys();
  const preferred = imageKeyStartIndex(slot, attempt, keys.length);
  const now = Date.now();

  // Walk from the preferred key and take the first one that is not resting.
  // If they are all resting, fall back to the preferred one rather than wait.
  let chosen = preferred;
  for (let i = 0; i < keys.length; i++) {
    const idx = (preferred + i) % keys.length;
    const candidate = keys[idx] as string;
    const rest = restingUntil.get(candidate) ?? 0;
    if (rest <= now) {
      if (rest) restingUntil.delete(candidate);
      chosen = idx;
      break;
    }
  }

  return fn(keys[chosen] as string, chosen);
}
