import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/agnes-keys")({
  server: {
    handlers: {
      GET: async () => {
        const names = Array.from({ length: 9 }, (_, index) => `AGNES_API_KEY_${index + 1}`);
        const keys = names
          .map((name) => process.env[name]?.trim())
          .filter((key): key is string => typeof key === "string" && key.length > 0);

        if (keys.length === 0) return new Response("Image keys are not configured", { status: 503 });
        return Response.json({ keys }, { headers: { "Cache-Control": "private, no-store" } });
      },
    },
  },
});