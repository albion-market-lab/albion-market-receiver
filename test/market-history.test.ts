import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { aggregateDailyActivity } from "../api/activity.js";
import { normalizeCollectorHistory, type MarketActivityRow } from "../src/market-history.js";

const fixture = async () => JSON.parse(await readFile(join(process.cwd(), "test/fixtures/collector-history-t4-ore.json"), "utf8")) as { receivedAt: string; payload: unknown };

test("normalizes the sanitized real v0.1.61 history payload and pinned AlbionId mapping", async () => {
  const input = await fixture();
  const result = normalizeCollectorHistory({ server: "East/Asia", ...input });
  assert.equal(result.received, 12);
  assert.deepEqual(result.rows[0], {
    server: "East/Asia", itemId: "T4_ORE", city: "Bridgewatch", quality: 1, timescale: 1,
    bucketTimestamp: "2026-10-31T18:00:00.000Z", itemAmount: 217, silverAmount: 251720000,
    observedAt: input.receivedAt, source: "local_collector",
  });
});

test("normalizes every Royal City including leading-zero Thetford", async () => {
  const input = await fixture();
  for (const [locationId, city] of [["2004", "Bridgewatch"], ["3008", "Martlock"], ["1002", "Lymhurst"], ["4002", "Fort Sterling"], ["7", "Thetford"], ["0007", "Thetford"]]) {
    const payload = { ...(input.payload as object), LocationId: locationId };
    assert.equal(normalizeCollectorHistory({ server: "East/Asia", receivedAt: input.receivedAt, payload }).rows[0]?.city, city);
  }
});

test("keeps timescales separate and rejects invalid dimensions and timestamps", async () => {
  const input = await fixture();
  for (const timescale of [0, 1, 2]) {
    const payload = { ...(input.payload as object), Timescale: timescale };
    assert.equal(normalizeCollectorHistory({ server: "East/Asia", receivedAt: input.receivedAt, payload }).rows[0]?.timescale, timescale);
  }
  for (const payload of [
    { ...(input.payload as object), Timescale: 3 },
    { ...(input.payload as object), AlbionId: 999999 },
    { ...(input.payload as object), MarketHistories: [{ ItemAmount: 1, SilverAmount: 1, Timestamp: 1 }] },
  ]) assert.throws(() => normalizeCollectorHistory({ server: "East/Asia", receivedAt: input.receivedAt, payload }));
});

test("deduplicates repeated buckets and aggregates only complete four-bucket UTC days", async () => {
  const input = await fixture();
  const normalized = normalizeCollectorHistory({ server: "East/Asia", ...input });
  const duplicatePayload = { ...(input.payload as object), MarketHistories: [...(input.payload as { MarketHistories: unknown[] }).MarketHistories, (input.payload as { MarketHistories: unknown[] }).MarketHistories[0]] };
  assert.equal(normalizeCollectorHistory({ server: "East/Asia", receivedAt: input.receivedAt, payload: duplicatePayload }).rows.length, normalized.rows.length);
  const activity = aggregateDailyActivity(normalized.rows as MarketActivityRow[]);
  assert.equal(activity.length, 1);
  assert.equal(activity[0]?.coverageDays, 3);
  assert.equal(activity[0]?.averageDailyUnits, normalized.rows.reduce((sum, row) => sum + row.itemAmount, 0) / 3);
});
