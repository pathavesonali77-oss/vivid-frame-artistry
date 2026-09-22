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
 * The keys are deliberately visible here — the owner asked for that, they are
 * temporary, and they are replaceable at any time.
 */
import { panelPayloads } from "./manga.functions";

const AGNES_URL = "https://apihub.agnes-ai.com/v1/images/generations";
const AGNES_MODEL = "agnes-image-2.5-flash";

/** Temporary, intentionally public image keys. Replace freely. */
export const AGNES_KEYS: string[] = [
  "sk-I04D4YBECov6kYvbrk2JRno1VY2xyGgxWeJNb7pOPZ43q5fG",
  "sk-OoJrEYImZTN6by4tJoINV0AChxoT5AJyZmKQwcdVBBqDcDZ3",
  "sk-fLpoyFOy5Z71A6aMNQ3tcNCeYoVecwQ33wuYCZe3dbhOTDsw",
  "sk-WL5r5FFNnObn2wQjCkkLClWBC3f73PlDBypFTLOb7GFEIoKL",
  "sk-fe22dNmaZd73KSRYbK3b6os6fRWs6XfJl2xiOWXul1IOBMWy",
  "sk-wQiIb8lIWUkk7vgTgjg6BsSUJzzUMFlIWe0lrcGi7Zy9O2IA",
  "sk-309O5z4TSAHpyjJTmHVHjGQxwz3p3u3U1iyMDJMabTHLHyt8",
  "sk-IqcotNMoQYeQ1CLMaWncXaZI1dTu7VCMEVOGYGcV4yjf7vTC",
  "sk-dswO8vZF7EQuPKQa1cfH7X3zkIRSn5ykSTsSqLd2b4dAvjWC",
];

/** Per-key pause after that key itself was throttled. */
const cooldown = new Map<number, number>();
let cursor = 0;

function nextKey(): { key: string; slot: number } {
  for (let hop = 0; hop < AGNES_KEYS.length; hop++) {
    const slot = cursor++ % AGNES_KEYS.length;
    const until = cooldown.get(slot) ?? 0;
    if (Date.now() >= until) return { key: AGNES_KEYS[slot] as string, slot };
  }
  const slot = cursor++ % AGNES_KEYS.length;
  return { key: AGNES_KEYS[slot] as string, slot };
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
  const { key, slot } = nextKey();
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
