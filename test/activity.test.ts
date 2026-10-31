import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateDailyActivity, createActivityHandler } from "../api/activity.js";
import type { MarketActivityRow } from "../src/market-history.js";

const row = (bucketTimestamp: string, itemAmount = 100, overrides: Partial<MarketActivityRow> = {}): MarketActivityRow => ({
  server: "East/Asia", itemId: "T4_ORE", city: "Bridgewatch", quality: 1, timescale: 1,
  bucketTimestamp, itemAmount, silverAmount: 1000,
  observedAt: "2026-11-01T00:00:00.000Z", source: "local_collector", ...overrides,
});

const day = (date: string, amount = 100) => [0, 6, 12, 18].map((hour) => row(`${date}T${String(hour).padStart(2, "0")}:00:00.000Z`, amount));

test("daily activity excludes an unfinished final bucket and includes it at the boundary", () => {
  const rows = [...day("2026-10-30"), ...day("2026-10-31")];
  assert.deepEqual(aggregateDailyActivity(rows, new Date("2026-10-31T18:50:00.000Z"))[0], {
    server: "East/Asia", itemId: "T4_ORE", city: "Bridgewatch", quality: 1,
    averageDailyUnits: 400, coverageDays: 1, observedAt: "2026-11-01T00:00:00.000Z",
  });
  assert.equal(aggregateDailyActivity(day("2026-10-31"), new Date("2026-11-01T00:00:00.000Z"))[0]?.coverageDays, 1);
});

test("daily activity requires every bucket and ignores other timescales", () => {
  const missing = day("2026-10-31").slice(0, 3);
  assert.deepEqual(aggregateDailyActivity(missing, new Date("2026-11-01T00:00:00.000Z")), []);
  assert.deepEqual(aggregateDailyActivity(day("2026-10-31").map((item) => ({ ...item, timescale: 0 })), new Date("2026-11-01T00:00:00.000Z")), []);
});

test("daily activity keeps the newest duplicate observation without double counting", () => {
  const rows = day("2026-10-31");
  rows.push(row("2026-10-31T18:00:00.000Z", 250, { observedAt: "2026-11-01T00:01:00.000Z" }));
  const activity = aggregateDailyActivity(rows, new Date("2026-11-01T01:00:00.000Z"))[0];
  assert.equal(activity?.coverageDays, 1);
  assert.equal(activity?.averageDailyUnits, 550);
  assert.equal(activity?.observedAt, "2026-11-01T00:01:00.000Z");
});

test("daily activity honors the seven-day window at a UTC day boundary", () => {
  const rows = [...day("2026-10-24", 900), ...day("2026-10-25"), ...day("2026-10-31", 200)];
  const activity = aggregateDailyActivity(rows, new Date("2026-11-01T00:00:00.000Z"))[0];
  assert.equal(activity?.coverageDays, 2);
  assert.equal(activity?.averageDailyUnits, 600);
});

test("activity handler uses its injected clock without changing the response contract", async () => {
  const rows = day("2026-10-31");
  const handler = createActivityHandler({
    env: { APPS_SCRIPT_URL: "https://script.google.test/exec", APPS_SCRIPT_SECRET: "secret", WEB_ORIGIN: "https://web.test" },
    fetchImpl: async () => Response.json({ ok: true, server: "East/Asia", rows }),
    now: () => new Date("2026-11-01T00:00:00.000Z"),
  });
  const response = await handler(new Request("https://receiver.test/activity?server=East%2FAsia&itemIds=T4_ORE", { headers: { origin: "https://web.test" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    server: "East/Asia",
    items: [{ server: "East/Asia", itemId: "T4_ORE", city: "Bridgewatch", quality: 1, averageDailyUnits: 400, coverageDays: 1, observedAt: "2026-11-01T00:00:00.000Z" }],
  });
});
