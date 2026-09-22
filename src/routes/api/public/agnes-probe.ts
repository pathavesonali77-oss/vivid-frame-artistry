import { createFileRoute } from "@tanstack/react-router";
import { agnesKeys } from "@/lib/keys.server";

/**
 * Diagnostic only. Fires a few tiny image requests at the provider FROM THE
 * SERVER THAT IS ACTUALLY RUNNING (dev sandbox or live hosting) and reports the
 * raw status of each one, spaced by `gap` milliseconds.
 *
 * This is how we tell the two failure shapes apart:
 *   - statuses turn 429/1015 only as the spacing shrinks -> a rate problem that
 *     slowing down and backing off genuinely fixes;
 *   - every single request is blocked even one at a time -> the provider's edge
 *     is blocking the hosting network itself, and no amount of pacing helps.
 *
 * Returns no key material.
 */
export const Route = createFileRoute("/api/public/agnes-probe")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const q = new URL(request.url).searchParams;
        const n = Math.min(10, Math.max(1, Number(q.get("n") ?? 3)));
        const gap = Math.min(30_000, Math.max(0, Number(q.get("gap") ?? 3000)));
        let keys: string[] = [];
        try {
          keys = agnesKeys();
        } catch (e) {
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }

        const results: {
          i: number;
          key: number;
          status: number | null;
          ms: number;
          blocked1015: boolean;
          body: string;
        }[] = [];

        for (let i = 0; i < n; i++) {
          if (i > 0 && gap) await new Promise((r) => setTimeout(r, gap));
          const keyIndex = i % keys.length;
          const t0 = Date.now();
          try {
            const res = await fetch("https://apihub.agnes-ai.com/v1/images/generations", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${keys[keyIndex]}`,
              },
              body: JSON.stringify({
                model: "agnes-image-2.5-flash",
                prompt: "a single red apple on a plain table, simple illustration",
                size: "1K",
                ratio: "16:9",
                extra_body: { response_format: "url" },
              }),
            });
            const text = (await res.text().catch(() => "")).slice(0, 200);
            results.push({
              i,
              key: keyIndex + 1,
              status: res.status,
              ms: Date.now() - t0,
              blocked1015: /error code:?\s*1015/i.test(text),
              body: text,
            });
          } catch (e) {
            results.push({
              i,
              key: keyIndex + 1,
              status: null,
              ms: Date.now() - t0,
              blocked1015: false,
              body: (e instanceof Error ? e.message : String(e)).slice(0, 200),
            });
          }
        }

        return Response.json({
          ok: true,
          keys: keys.length,
          gapMs: gap,
          results,
        });
      },
    },
  },
});
