import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_PAYLOAD_BYTES = 1_048_576;
export const MAX_SAMPLES = 3;

interface ListenerOptions {
  outputDirectory: string;
  now?: () => Date;
}

function send(response: ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify({ message }));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_PAYLOAD_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isMarketUpload(value: unknown): value is { Orders: Record<string, unknown>[] } {
  if (!value || typeof value !== "object") return false;
  const orders = (value as { Orders?: unknown }).Orders;
  return Array.isArray(orders) && orders.length > 0 && orders.every((order) => order !== null && typeof order === "object" && !Array.isArray(order));
}

function isHistoryUpload(value: unknown): value is { MarketHistories: Record<string, unknown>[] } {
  if (!value || typeof value !== "object") return false;
  const upload = value as Record<string, unknown>;
  return Number.isInteger(upload.AlbionId)
    && typeof upload.LocationId === "string"
    && Number.isInteger(upload.QualityLevel)
    && Number.isInteger(upload.Timescale)
    && Array.isArray(upload.MarketHistories)
    && upload.MarketHistories.length > 0
    && upload.MarketHistories.every((history) => history !== null && typeof history === "object" && !Array.isArray(history));
}

export function createCollectorListener({ outputDirectory, now = () => new Date() }: ListenerOptions) {
  const sampleCounts = new Map<string, number>();

  return createServer(async (request, response) => {
    const kind = request.url === "/marketorders.ingest" ? "event" : request.url === "/markethistories.ingest" ? "history" : undefined;
    if (request.method !== "POST" || !kind) {
      send(response, 404, "Not found");
      return;
    }

    if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
      send(response, 415, "Content-Type must be application/json");
      return;
    }

    try {
      const body = await readBody(request);
      const payload: unknown = JSON.parse(body);
      if (kind === "event" ? !isMarketUpload(payload) : !isHistoryUpload(payload)) {
        send(response, 400, kind === "event" ? "Expected a non-empty Orders array" : "Expected a market history upload");
        return;
      }

      const receivedAt = now().toISOString();
      const sampleCount = sampleCounts.get(kind) ?? 0;
      if (sampleCount < MAX_SAMPLES) {
        sampleCounts.set(kind, sampleCount + 1);
        await mkdir(outputDirectory, { recursive: true });
        const timestamp = receivedAt.replace(/\D/g, "");
        await writeFile(join(outputDirectory, `collector-${kind}-${timestamp}-${randomUUID()}.json`), `${JSON.stringify({ receivedAt, payload }, null, 2)}\n`, { flag: "wx" });
      }

      const count = kind === "event"
        ? (payload as { Orders: unknown[] }).Orders.length
        : (payload as { MarketHistories: unknown[] }).MarketHistories.length;
      console.log(`Received market ${kind} at ${receivedAt}: ${count} records`);
      send(response, 200, "Accepted");
    } catch (error) {
      if (error instanceof Error && error.message === "PAYLOAD_TOO_LARGE") {
        send(response, 413, "Payload too large");
        return;
      }
      if (error instanceof SyntaxError) {
        send(response, 400, "Invalid JSON");
        return;
      }
      console.error("Failed to store collector event");
      send(response, 500, "Internal server error");
    }
  });
}

