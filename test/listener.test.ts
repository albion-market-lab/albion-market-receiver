import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createCollectorListener, MAX_PAYLOAD_BYTES, MAX_SAMPLES } from "../src/listener.js";

const servers: Server[] = [];
afterEach(() => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))));

async function start(existingOutputDirectory?: string) {
  const outputDirectory = existingOutputDirectory ?? await mkdtemp(join(tmpdir(), "market-receiver-"));
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
  const files = await readdir(outputDirectory);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^collector-event-20261028120000000-[0-9a-f-]{36}\.json$/);
  assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, files[0]!), "utf8")), {
    receivedAt: "2026-10-28T12:00:00.000Z",
    payload,
  });
});

test("stores a new sample after restart without overwriting existing files", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "market-receiver-"));
  await writeFile(join(outputDirectory, "collector-event-01.json"), "existing\n");
  const { url } = await start(outputDirectory);
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ Orders: [{}] }) });

  assert.equal(response.status, 200);
  assert.equal(await readFile(join(outputDirectory, "collector-event-01.json"), "utf8"), "existing\n");
  assert.equal((await readdir(outputDirectory)).length, 2);
});

test("stores at most three samples per session and keeps accepting events", async () => {
  const { outputDirectory, url } = await start();
  const responses = await Promise.all(Array.from({ length: MAX_SAMPLES + 2 }, () => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ Orders: [{}] }),
  })));

  assert.deepEqual(responses.map(({ status }) => status), [200, 200, 200, 200, 200]);
  assert.equal((await readdir(outputDirectory)).length, MAX_SAMPLES);
});

test("rejects payloads larger than one MiB", async () => {
  const { url } = await start();
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(MAX_PAYLOAD_BYTES + 1) });
  assert.equal(response.status, 413);
});

test("rejects invalid JSON", async () => {
  const { url } = await start();
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(response.status, 400);
});

test("rejects JSON without market orders", async () => {
  const { url } = await start();
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ Orders: [] }) });
  assert.equal(response.status, 400);
});

test("rejects unsupported routes", async () => {
  const { url } = await start();
  const response = await fetch(url.replace("marketorders.ingest", "other"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 404);
});

test("rejects unsupported content types", async () => {
  const { url } = await start();
  const response = await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  assert.equal(response.status, 415);
});

for (const side of ["buy", "sell"]) {
  test(`accepts the sanitized real ${side.toUpperCase()} fixture`, async () => {
    const fixturePath = join(process.cwd(), "test", "fixtures", `collector-event-${side}.json`);
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { payload: unknown };
    const { url } = await start();
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixture.payload) });
    assert.equal(response.status, 200);
  });
}

