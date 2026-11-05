import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { evaluate } from "../src/decide.js";
import { serializeJson } from "../src/observe.js";
import {
  parseRiskDecision,
  parseRiskRequest,
  policyConfigFromRequest,
  stateFromRiskRequest,
} from "../src/riskEngine.js";
import type { RiskDecision } from "../src/types.js";

interface ControlState {
  forced: RiskDecision | undefined;
  failMode: "500" | "timeout" | "garbage" | null;
  delayMs: number;
}

const control: ControlState = { forced: undefined, failMode: null, delayMs: 0 };
const port = Number(process.env["RISK_ENGINE_PORT"] ?? "8081");

const server = createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    fail(res, 500, error instanceof Error ? error.message : String(error));
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET" && req.url === "/health") {
    send(res, 200, {
      ok: true,
      service: "stub-risk-engine",
      forced: control.forced !== undefined,
      forcedAction: control.forced?.action?.kind ?? null,
      failMode: control.failMode,
    });
    return;
  }

  if (req.url === "/control" && req.method === "POST") {
    const body = parseJson(await readBody(req)) as Record<string, unknown>;
    if (body["failMode"] !== undefined) {
      const mode = body["failMode"];
      if (mode !== null && mode !== "500" && mode !== "timeout" && mode !== "garbage") {
        fail(res, 400, "failMode must be null, 500, timeout or garbage");
        return;
      }
      control.failMode = mode;
    }
    if ("forceDecision" in body) {
      control.forced = body["forceDecision"] === null ? undefined : parseRiskDecision(body["forceDecision"]);
    }
    if (typeof body["delayMs"] === "number") control.delayMs = body["delayMs"];
    send(res, 200, { ok: true, control: controlSummary() });
    return;
  }

  if (req.url === "/control" && req.method === "DELETE") {
    control.forced = undefined;
    control.failMode = null;
    control.delayMs = 0;
    send(res, 200, { ok: true });
    return;
  }

  if (req.url === "/decide" && req.method === "POST") {
    if (control.failMode === "500") {
      fail(res, 500, "forced risk engine failure");
      return;
    }
    if (control.failMode === "timeout") {
      await sleep(control.delayMs > 0 ? control.delayMs : 30_000);
      send(res, 200, { action: null, reason: "late" });
      return;
    }
    if (control.failMode === "garbage") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not valid json");
      return;
    }

    const raw = await readBody(req);
    let request;
    try {
      request = parseRiskRequest(parseJson(raw));
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : String(error));
      return;
    }

    const decision = control.forced ?? evaluate(
      stateFromRiskRequest(request),
      request.keeper.now,
      policyConfigFromRequest(request),
    );

    process.stdout.write(`${serializeJson({
      event: "risk-engine-decision",
      block: request.blockNumber,
      action: decision.action?.kind ?? null,
      reason: decision.reason,
      liquidatableCount: request.state.borrowers.filter((b) => b.liquidatable).length,
    })}\n`);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(serializeJson(decision));
    return;
  }

  fail(res, 404, "not found");
}

function controlSummary(): Record<string, unknown> {
  return {
    forced: control.forced !== undefined,
    forcedAction: control.forced?.action?.kind ?? null,
    failMode: control.failMode,
    delayMs: control.delayMs,
  };
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
    if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) {
      throw new Error("request body too large");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(serializeJson(body));
}

function fail(res: ServerResponse, status: number, message: string): void {
  send(res, status, { error: message });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`${serializeJson({ event: "stub-risk-engine-start", port })}\n`);
});
