import { createHash } from "node:crypto";
import { persistWithAppsScript } from "../src/apps-script-client.js";
import { InvalidIngestError, normalizeCollectorEvent } from "../src/market-ingest.js";

const MAX_PAYLOAD_BYTES = 1_048_576;

interface HandlerOptions {
  now?: () => Date;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function createMarketOrdersHandler({ now = () => new Date(), fetchImpl, env = process.env }: HandlerOptions = {}) {
  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return json(405, { message: "Method not allowed" });
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") return json(415, { message: "Content-Type must be application/json" });
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_PAYLOAD_BYTES) return json(413, { message: "Payload too large" });

    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > MAX_PAYLOAD_BYTES) return json(413, { message: "Payload too large" });
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return json(400, { message: "Invalid JSON" });
    }

    const url = env.APPS_SCRIPT_URL;
    const secret = env.APPS_SCRIPT_SECRET;
    if (!url || !secret) return json(503, { message: "Service unavailable" });
    const receivedAt = now().toISOString();
    try {
      const normalized = normalizeCollectorEvent({ server: "East/Asia", receivedAt, payload });
      const result = await persistWithAppsScript({ ...normalized, eventId: createHash("sha256").update(rawBody).digest("hex") }, { url, secret, ...(fetchImpl ? { fetchImpl } : {}) });
      return json(200, { received: normalized.received, written: result.written, duplicate: result.duplicate, receivedAt });
    } catch (error) {
      if (error instanceof InvalidIngestError) return json(400, { message: error.message });
      console.error("Market persistence failed.");
      return json(502, { message: "Persistence unavailable" });
    }
  };
}

export default { fetch: createMarketOrdersHandler() };

