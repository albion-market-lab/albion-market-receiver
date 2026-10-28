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

export function createCollectorListener({ outputDirectory, now = () => new Date() }: ListenerOptions) {
  let sampleCount = 0;

  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/marketorders.ingest") {
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
      if (!isMarketUpload(payload)) {
        send(response, 400, "Expected a non-empty Orders array");
        return;
      }

      const receivedAt = now().toISOString();
      if (sampleCount < MAX_SAMPLES) {
        sampleCount += 1;
        await mkdir(outputDirectory, { recursive: true });
        const timestamp = receivedAt.replace(/\D/g, "");
        await writeFile(join(outputDirectory, `collector-event-${timestamp}-${randomUUID()}.json`), `${JSON.stringify({ receivedAt, payload }, null, 2)}\n`, { flag: "wx" });
      }

      console.log(`Received market event at ${receivedAt}: ${payload.Orders.length} orders`);
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

