import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createCollectorListener } from "../src/listener.js";

const servers: Server[] = [];
afterEach(() => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))));

async function start() {
  const outputDirectory = await mkdtemp(join(tmpdir(), "market-receiver-"));
  const server = createCollectorListener({ outputDirectory, now: () => new Date("2026-10-28T12:00:00Z") });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { outputDirectory, url: `http://127.0.0.1:${port}/marketorders.ingest` };
}

test("accepts and stores a market-order upload with receipt time", async () => {
  const { outputDirectory, url } = await start();
  const payload = { Orders: [{ ItemTypeId: "T4_ORE", AuctionType: "request", UnitPriceSilver: 100 }] };
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

  assert.equal(response.status, 200);
  assert.deepEqual(await readdir(outputDirectory), ["collector-event-01.json"]);
  assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, "collector-event-01.json"), "utf8")), {
    receivedAt: "2026-10-28T12:00:00.000Z",
    payload,
  });
});

test("rejects malformed payloads and unsupported routes", async () => {
  const { url } = await start();
  const invalid = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ Orders: [] }) });
  const missing = await fetch(url.replace("marketorders.ingest", "other"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

  assert.equal(invalid.status, 400);
  assert.equal(missing.status, 404);
});

