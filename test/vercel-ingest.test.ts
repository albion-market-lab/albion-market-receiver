import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createMarketOrdersHandler } from "../api/marketorders.ingest.js";

const fixture = async (side: "buy" | "sell") => JSON.parse(await readFile(join(process.cwd(), `test/fixtures/collector-event-${side}.json`), "utf8")) as { payload: unknown };

test("Vercel handler accepts a real collector payload and forwards normalized rows", async () => {
  let forwarded: Record<string, unknown> | undefined;
  const handler = createMarketOrdersHandler({
    now: () => new Date("2026-10-28T17:00:00Z"),
    env: { APPS_SCRIPT_URL: "https://script.google.test/exec", APPS_SCRIPT_SECRET: "shared-secret" },
    fetchImpl: async (_input, init) => {
      forwarded = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ ok: true, written: 1, duplicate: false });
    },
  });
  const { payload } = await fixture("buy");
  const response = await handler(new Request("https://receiver.test/marketorders.ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: 1, written: 1, duplicate: false, receivedAt: "2026-10-28T17:00:00.000Z" });
  assert.equal(forwarded?.secret, "shared-secret");
  assert.match(String(forwarded?.eventId), /^[a-f0-9]{64}$/);
  assert.equal((forwarded?.rows as unknown[]).length, 1);
});

test("Vercel handler accepts a sanitized Thetford batch without changing the raw-body fingerprint", async () => {
  let forwarded: Record<string, unknown> | undefined;
  const handler = createMarketOrdersHandler({
    now: () => new Date("2026-10-29T12:00:00Z"),
    env: { APPS_SCRIPT_URL: "https://script.google.test/exec", APPS_SCRIPT_SECRET: "shared-secret" },
    fetchImpl: async (_input, init) => {
      forwarded = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ ok: true, written: 1, duplicate: false });
    },
  });
  const { payload } = await fixture("buy") as { payload: { Orders: Array<Record<string, unknown>> } };
  payload.Orders = [
    { ...payload.Orders[0], LocationId: "0007" },
    { ...payload.Orders[0], LocationId: "00007", AuctionType: "offer", UnitPriceSilver: 3_900_000 },
  ];
  const rawBody = JSON.stringify(payload);
  const response = await handler(new Request("https://receiver.test/marketorders.ingest", { method: "POST", headers: { "content-type": "application/json" }, body: rawBody }));
  assert.equal(response.status, 200);
  assert.equal(forwarded?.eventId, createHash("sha256").update(rawBody).digest("hex"));
  const rows = forwarded?.rows as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.city, "Thetford");
});

test("Vercel handler rejects malformed and oversized requests", async () => {
  const handler = createMarketOrdersHandler({ env: { APPS_SCRIPT_URL: "https://script.google.test/exec", APPS_SCRIPT_SECRET: "shared-secret" } });
  const invalid = await handler(new Request("https://receiver.test/marketorders.ingest", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }));
  const oversized = await handler(new Request("https://receiver.test/marketorders.ingest", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1_048_577) }));
  const wrongType = await handler(new Request("https://receiver.test/marketorders.ingest", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }));
  assert.equal(invalid.status, 400);
  assert.equal(oversized.status, 413);
  assert.equal(wrongType.status, 415);
});

test("Vercel handler returns an error when Apps Script persistence fails", async () => {
  const handler = createMarketOrdersHandler({
    env: { APPS_SCRIPT_URL: "https://script.google.test/exec", APPS_SCRIPT_SECRET: "shared-secret" },
    fetchImpl: async () => Response.json({ ok: false, error: "quota" }),
  });
  const { payload } = await fixture("sell");
  const response = await handler(new Request("https://receiver.test/marketorders.ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
  assert.equal(response.status, 502);
});
