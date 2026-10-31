import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createMarketHistoriesHandler } from "../api/markethistories.ingest.js";

test("history handler accepts a sanitized real payload and forwards activity rows", async () => {
  const fixture = JSON.parse(await readFile(join(process.cwd(), "test/fixtures/collector-history-t4-ore.json"), "utf8")) as { payload: unknown };
  let forwarded: Record<string, unknown> | undefined;
  const handler = createMarketHistoriesHandler({
    now: () => new Date("2026-10-31T18:21:16.506Z"),
    env: { APPS_SCRIPT_URL: "https://script.google.test/exec", APPS_SCRIPT_SECRET: "secret" },
    fetchImpl: async (_input, init) => { forwarded = JSON.parse(String(init?.body)); return Response.json({ ok: true, written: 12, duplicate: false }); },
  });
  const response = await handler(new Request("https://receiver.test/markethistories.ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixture.payload) }));
  assert.equal(response.status, 200);
  assert.equal(forwarded?.action, "writeActivity");
  assert.equal((forwarded?.rows as unknown[]).length, 12);
});

test("history handler rejects malformed payloads without persistence", async () => {
  let calls = 0;
  const handler = createMarketHistoriesHandler({
    env: { APPS_SCRIPT_URL: "https://script.google.test/exec", APPS_SCRIPT_SECRET: "secret" },
    fetchImpl: async () => { calls += 1; return Response.json({ ok: true, written: 0, duplicate: false }); },
  });
  const response = await handler(new Request("https://receiver.test/markethistories.ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ AlbionId: 1000, Timescale: 9 }) }));
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});
