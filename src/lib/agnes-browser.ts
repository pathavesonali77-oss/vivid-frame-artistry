/**
 * Picture requests made BY THE BROWSER.
 *
 * The published site runs its server code behind one shared outgoing address.
 * The picture service's edge counts requests per address, so a single run —
 * even with one user and nine keys — trips "error code: 1015" and every later
 * panel fails. Nothing on the server can fix that: the block is on the address,
 * not on the account.
 *
 * So the request is made from the visitor's own connection instead. The server
 * still writes every prompt; only the final HTTP call moves into the page.
 * Temporary keys are delivered at runtime rather than committed to source.
 */
import { panelPayloads } from "./manga.functions";

const AGNES_URL = "https://apihub.agnes-ai.com/v1/images/generations";
const AGNES_MODEL = "agnes-image-2.5-flash";

let keysPromise: Promise<string[]> | undefined;

function loadKeys(): Promise<string[]> {
  if (!keysPromise) {
    keysPromise = fetch("/api/agnes-keys")
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.text()) || "Image keys are unavailable");
        const payload = (await response.json()) as { keys?: unknown };
        if (!Array.isArray(payload.keys)) throw new Error("Image keys are unavailable");
        const keys = payload.keys.filter((key): key is string => typeof key === "string" && key.length > 0);
        if (keys.length === 0) throw new Error("Image keys are unavailable");
        return keys;
      })
      .catch((error) => {
        keysPromise = undefined;
        throw error;
      });
  }
  return keysPromise;
}

/** Per-key pause after that key itself was throttled. */
const cooldown = new Map<number, number>();
let cursor = 0;

function nextKey(keys: string[]): { key: string; slot: number } {
  for (let hop = 0; hop < keys.length; hop++) {
    const slot = cursor++ % keys.length;
    const until = cooldown.get(slot) ?? 0;
    const key = keys[slot];
    if (Date.now() >= until && key) return { key, slot };
  }
  const slot = cursor++ % keys.length;
  const key = keys[slot];
  if (!key) throw new Error("Image keys are unavailable");
  return { key, slot };
}

const REQUEST_TIMEOUT_MS = 90_000;

export type ImageJob = {
  index: number;
  prompt: string;
  seed: number;
  slot?: number;
  line?: string | undefined;
  timestamp?: string | undefined;
  continuity?: string | undefined;
};

export type ImageResult = {
  index: number;
  url: string | null;
  prompt?: string;
  rewritten?: boolean;
  error?: string;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** One picture request, straight from this browser. */
async function askForImage(
  prompt: string,
  signal?: AbortSignal,
): Promise<{ url?: string; error?: string; throttled?: boolean }> {
  const keys = await loadKeys();
  const { key, slot } = nextKey(keys);
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => stop.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(AGNES_URL, {
      method: "POST",
      signal: stop.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: AGNES_MODEL,
        prompt,
        size: "1K",
        ratio: "16:9",
        extra_body: { response_format: "url" },
      }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data?: { url?: string | null }[] };
      const url = json.data?.[0]?.url ?? undefined;
      if (url) return { url };
      return { error: "no output url" };
    }
    const text = await res.text().catch(() => "");
    const throttled =
      res.status === 429 || /error code:?\s*1015|rate limit|too many requests/i.test(text);
    if (throttled) cooldown.set(slot, Date.now() + 8_000);
    return { error: `${res.status} ${text}`.slice(0, 300), throttled };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const MAX_TRIES = 7;

/** Draws one panel in the browser, walking the server-written wording ladder. */
async function drawOne(
  job: ImageJob,
  payload: { display: string; ladder: string[] },
  signal?: AbortSignal,
): Promise<ImageResult> {
  const ladder = payload.ladder.length > 0 ? payload.ladder : [job.prompt];
  let lastErr = "render failed";
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    if (signal?.aborted) return { index: job.index, url: null, error: "cancelled" };
    // Attempts 0-2 use the full wording, then the softened one, then the plainest.
    const step = attempt < 3 ? 0 : attempt < 5 ? 1 : 2;
    const base = ladder[Math.min(step, ladder.length - 1)] as string;
    const text =
      attempt === 0 ? base : `${base} [render variation ${job.seed + attempt * 131}]`;
    const out = await askForImage(text, signal);
    if (out.url) {
      return { index: job.index, url: out.url, prompt: payload.display, rewritten: step > 0 };
    }
    lastErr = out.error ?? "render failed";
    await sleep(out.throttled ? Math.min(6_000, 900 * (attempt + 1)) : 250, signal);
  }
  return { index: job.index, url: null, error: lastErr };
}

/** Same answer shape as the old server batch, drawn from the page instead. */
export async function renderBatchInBrowser(args: {
  data: { bible?: string | undefined; jobs: ImageJob[]; runAt?: number | undefined };
  signal?: AbortSignal;
}): Promise<{ results: ImageResult[] }> {
  const { bible, jobs } = args.data;
  const payloadRequest = {
    data: {
      bible,
      runAt: args.data.runAt,
      jobs: jobs.map((j) => ({
        index: j.index,
        prompt: j.prompt,
        line: j.line,
        timestamp: j.timestamp,
        continuity: j.continuity,
      })),
    },
    ...(args.signal ? { signal: args.signal } : {}),
  };
  const payloads = (await panelPayloads(payloadRequest)) as {
    payloads: { index: number; display: string; ladder: string[] }[];
  };

  const results = await Promise.all(
    jobs.map(async (job) => {
      const payload =
        payloads.payloads.find((p) => p.index === job.index) ??
        { index: job.index, display: job.prompt, ladder: [job.prompt] };
      return drawOne(job, payload, args.signal);
    }),
  );
  return { results };
}

/** Single-panel version, matching the old single render call. */
export async function renderImageInBrowser(args: {
  data: {
    prompt: string;
    seed: number;
    bible?: string | undefined;
    line?: string | undefined;
    timestamp?: string | undefined;
    slot?: number;
    continuity?: string | undefined;
    runAt?: number;
  };
  signal?: AbortSignal;
}): Promise<{ url: string; prompt: string; rewritten: boolean }> {
  const request = {
    data: {
      bible: args.data.bible,
      runAt: args.data.runAt,
      jobs: [
        {
          index: 0,
          prompt: args.data.prompt,
          seed: args.data.seed,
          line: args.data.line,
          timestamp: args.data.timestamp,
          continuity: args.data.continuity,
        },
      ],
    },
    ...(args.signal ? { signal: args.signal } : {}),
  };
  const { results } = await renderBatchInBrowser(request);
  const first = results[0];
  if (!first?.url) throw new Error(first?.error ?? "Image generation failed");
  return { url: first.url, prompt: first.prompt ?? args.data.prompt, rewritten: !!first.rewritten };
}
