import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { MARKET_PRICE_HEADERS, type MarketPriceRow } from "../src/market-ingest.js";

async function harness(lockAvailable = true) {
  const table: Array<Array<string | number>> = [[...MARKET_PRICE_HEADERS]];
  const properties = new Map<string, string>([["INGEST_SECRET", "shared-secret"]]);
  let locked = false;
  const context = vm.createContext({
    console,
    LockService: { getScriptLock: () => ({ tryLock: () => { locked = lockAvailable; return lockAvailable; }, hasLock: () => locked, releaseLock: () => { locked = false; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key: string) => properties.get(key) ?? null, setProperty: (key: string, value: string) => properties.set(key, value) }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => ({
      getLastRow: () => table.length,
      getRange: (row: number, column: number, rowCount: number, columnCount: number) => ({
        getValues: () => table.slice(row - 1, row - 1 + rowCount).map((values) => values.slice(column - 1, column - 1 + columnCount)),
        setValues: (values: Array<Array<string | number>>) => values.forEach((next, index) => { table[row - 1 + index] = [...next]; }),
      }),
    }) }) },
    ContentService: { MimeType: { JSON: "JSON" }, createTextOutput: (text: string) => ({ text, setMimeType() { return this; } }) },
  });
  vm.runInContext(await readFile(join(process.cwd(), "apps-script/Code.gs"), "utf8"), context);
  const doPost = context.doPost as (event: { postData: { contents: string } }) => { text: string };
  return {
    table,
    post: (body: unknown) => JSON.parse(doPost({ postData: { contents: JSON.stringify(body) } }).text) as { ok: boolean; written?: number; duplicate?: boolean },
  };
}

const row = (overrides: Partial<MarketPriceRow> = {}): MarketPriceRow => ({
  server: "East/Asia", itemId: "T5_FIBER", city: "Martlock", quality: 1,
  highestBuyPrice: 372, highestBuyObservedAt: "2026-10-28T15:18:17.108Z",
  lowestSellPrice: null, lowestSellObservedAt: null,
  lastIngestedAt: "2026-10-28T15:18:17.108Z", source: "local_collector", ...overrides,
});

test("Apps Script inserts once and deduplicates exact replay", async () => {
  const app = await harness();
  assert.deepEqual(app.post({ secret: "shared-secret", eventId: "a".repeat(64), rows: [row()] }), { ok: true, written: 1, duplicate: false });
  assert.deepEqual(app.post({ secret: "shared-secret", eventId: "a".repeat(64), rows: [row()] }), { ok: true, written: 0, duplicate: true });
  assert.equal(app.table.length, 2);
});

test("Apps Script preserves BUY while updating SELL and ignores older observations", async () => {
  const app = await harness();
  app.post({ secret: "shared-secret", eventId: "a".repeat(64), rows: [row()] });
  app.post({ secret: "shared-secret", eventId: "b".repeat(64), rows: [row({
    highestBuyPrice: null, highestBuyObservedAt: null, lowestSellPrice: 390,
    lowestSellObservedAt: "2026-10-28T16:00:00.000Z", lastIngestedAt: "2026-10-28T16:00:00.000Z",
  })] });
  app.post({ secret: "shared-secret", eventId: "c".repeat(64), rows: [row({
    highestBuyPrice: 999, highestBuyObservedAt: "2026-10-28T14:00:00.000Z", lastIngestedAt: "2026-10-28T14:00:00.000Z",
  })] });
  assert.equal(app.table[1]![4], 372);
  assert.equal(app.table[1]![6], 390);
  assert.equal(app.table.length, 2);
});

test("Apps Script rejects an incorrect shared secret", async () => {
  const app = await harness();
  assert.equal(app.post({ secret: "wrong", eventId: "a".repeat(64), rows: [row()] }).ok, false);
  assert.equal(app.table.length, 1);
});

test("Apps Script rejects a concurrent write when the lock is unavailable", async () => {
  const app = await harness(false);
  assert.equal(app.post({ secret: "shared-secret", eventId: "a".repeat(64), rows: [row()] }).ok, false);
  assert.equal(app.table.length, 1);
});
