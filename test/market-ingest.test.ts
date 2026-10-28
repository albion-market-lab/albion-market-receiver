import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { InvalidIngestError, normalizeCollectorEvent } from "../src/market-ingest.js";

const order = (overrides: Record<string, unknown> = {}) => ({
  ItemTypeId: "T5_FIBER", LocationId: "3008", QualityLevel: 1, EnchantmentLevel: 0,
  UnitPriceSilver: 3_720_000, Amount: 67, AuctionType: "request", ...overrides,
});
const envelope = (receivedAt: string, orders = [order()]) => ({ server: "East/Asia", receivedAt, payload: { Orders: orders } });

test("inserts a normalized BUY row from the real collector shape", async () => {
  const fixture = JSON.parse(await readFile(join(process.cwd(), "test/fixtures/collector-event-buy.json"), "utf8")) as { receivedAt: string; payload: { Orders: unknown[] } };
  const result = normalizeCollectorEvent({ server: "East/Asia", ...fixture });
  assert.equal(result.received, 1);
  assert.deepEqual(result.rows[0], {
    server: "East/Asia", itemId: "T5_FIBER", city: "Martlock", quality: 1,
    highestBuyPrice: 372, highestBuyObservedAt: fixture.receivedAt, lowestSellPrice: null,
    lowestSellObservedAt: null, lastIngestedAt: fixture.receivedAt, source: "local_collector",
  });
});

test("keeps item, city, quality, and enchantment keys separate", async () => {
  const result = normalizeCollectorEvent(envelope("2026-10-28T12:00:00Z", [
    order(),
    order({ LocationId: "2004" }),
    order({ QualityLevel: 2 }),
    order({ ItemTypeId: "T5_FIBER", EnchantmentLevel: 1 }),
  ]));
  assert.deepEqual(result.rows.map(({ itemId, city, quality }) => [itemId, city, quality]), [
    ["T5_FIBER", "Martlock", 1], ["T5_FIBER", "Bridgewatch", 1],
    ["T5_FIBER", "Martlock", 2], ["T5_FIBER@1", "Martlock", 1],
  ]);
});

test("selects the highest BUY and lowest SELL within one collector batch", () => {
  const result = normalizeCollectorEvent(envelope("2026-10-28T12:00:00Z", [
    order({ UnitPriceSilver: 3_700_000 }),
    order({ UnitPriceSilver: 3_800_000 }),
    order({ UnitPriceSilver: 3_600_000 }),
    order({ AuctionType: "offer", UnitPriceSilver: 4_100_000 }),
    order({ AuctionType: "offer", UnitPriceSilver: 3_900_000 }),
    order({ AuctionType: "offer", UnitPriceSilver: 4_000_000 }),
  ]));
  assert.equal(result.rows[0]!.highestBuyPrice, 380);
  assert.equal(result.rows[0]!.lowestSellPrice, 390);
});

test("accepts the actual SELL fixture", async () => {
  const fixture = JSON.parse(await readFile(join(process.cwd(), "test/fixtures/collector-event-sell.json"), "utf8")) as { receivedAt: string; payload: unknown };
  const result = normalizeCollectorEvent({ server: "East/Asia", ...fixture });
  assert.equal(result.rows[0]!.lowestSellPrice, 7);
  assert.equal(result.rows[0]!.city, "Martlock");
});

test("rejects malformed collector payloads", async () => {
  assert.throws(() => normalizeCollectorEvent(envelope("not-a-date")), InvalidIngestError);
  assert.throws(() => normalizeCollectorEvent(envelope("2026-10-28T12:00:00Z", [order({ LocationId: "unknown" })])), InvalidIngestError);
  assert.throws(() => normalizeCollectorEvent({ server: "West", receivedAt: "2026-10-28T12:00:00Z", payload: { Orders: [order()] } }), InvalidIngestError);
});
