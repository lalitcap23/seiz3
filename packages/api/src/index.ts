import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { env } from "./env.js";
import { Collector } from "./collector.js";

const collector = new Collector();
collector.start();

const app = new Hono();
app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true, network: env.NETWORK }));

app.get("/snapshot", (c) => c.json(collector.latest));

app.get("/history", (c) => {
  const from = Number(c.req.query("from") ?? 0);
  return c.json(collector.history.filter((p) => p.t >= from));
});

app.get("/stream", (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "snapshot", data: JSON.stringify(collector.latest) });
    const unsubscribe = collector.subscribe(
      (s) => void stream.writeSSE({ event: "snapshot", data: JSON.stringify(s) }),
    );
    stream.onAbort(() => void unsubscribe());
    while (!stream.aborted) await stream.sleep(30_000);
  }),
);

app.post("/replay/:step", (c) => {
  if (c.req.header("authorization") !== `Bearer ${env.REPLAY_TOKEN}`)
    return c.json({ error: "unauthorized" }, 401);
  // TODO: forward to @afterbell/replay step runner
  return c.json({ ok: true, step: c.req.param("step") });
});

serve({ fetch: app.fetch, port: env.API_PORT }, (info) =>
  console.log(`[api] listening on http://localhost:${info.port}`),
);
