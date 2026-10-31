import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { MARKET_PRICE_HEADERS, type MarketPriceRow } from "../src/market-ingest.js";
import { MARKET_ACTIVITY_HEADERS, type MarketActivityRow } from "../src/market-history.js";

interface HarnessOptions {
  lockAvailable?: boolean;
  failSetValues?: boolean;
  activityMaxRows?: number;
}

async function harness({ lockAvailable = true, failSetValues = false, activityMaxRows = 2000 }: HarnessOptions = {}) {
  const table: Array<Array<string | number>> = [[...MARKET_PRICE_HEADERS]];
  const activityTable: Array<Array<string | number>> = [[...MARKET_ACTIVITY_HEADERS]];
  const properties = new Map<string, string>([["INGEST_SECRET", "shared-secret"]]);
  const operations: string[] = [];
  const maxRows = new Map([["Market Prices", 2000], ["Market Activity", activityMaxRows]]);
  let locked = false;
  const context = vm.createContext({
    console,
    LockService: { getScriptLock: () => ({
      tryLock: () => { operations.push("tryLock"); locked = lockAvailable; return lockAvailable; },
      hasLock: () => locked,
      releaseLock: () => { operations.push("releaseLock"); locked = false; },
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key: string) => properties.get(key) ?? null,
      setProperty: (key: string, value: string) => { operations.push("persistFingerprint"); properties.set(key, value); },
    }) },
    SpreadsheetApp: {
      flush: () => operations.push("flush"),
      getActiveSpreadsheet: () => ({ getSheetByName: (name: string) => {
        const selected = name === "Market Activity" ? activityTable : table;
        return ({
        getLastRow: () => selected.length,
        getMaxRows: () => maxRows.get(name)!,
        insertRowsAfter: (_row: number, count: number) => { operations.push("insertRowsAfter"); maxRows.set(name, maxRows.get(name)! + count); },
        deleteRows: (row: number, count: number) => { operations.push("deleteRows"); selected.splice(row - 1, count); maxRows.set(name, maxRows.get(name)! - count); },
        getRange: (row: number, column: number, rowCount: number, columnCount: number) => {
          if (row + rowCount - 1 > maxRows.get(name)!) throw new Error("Range exceeds grid limits");
          return ({
          getValues: () => selected.slice(row - 1, row - 1 + rowCount).map((values) => values.slice(column - 1, column - 1 + columnCount)),
          setValues: (values: Array<Array<string | number>>) => {
            operations.push("setValues");
            if (failSetValues) throw new Error("setValues failed");
            values.forEach((next, index) => { selected[row - 1 + index] = [...next]; });
          },
          clearContent: () => { operations.push("clearContent"); selected.splice(row - 1, rowCount); },
        }); },
      }); } }),
    },
    ContentService: { MimeType: { JSON: "JSON" }, createTextOutput: (text: string) => ({ text, setMimeType() { return this; } }) },
  });
  vm.runInContext(await readFile(join(process.cwd(), "apps-script/Code.gs"), "utf8"), context);
  const doPost = context.doPost as (event: { postData: { contents: string } }) => { text: string };
  return {
    operations,
    table,
    activityTable,
    post: (body: unknown) => JSON.parse(doPost({ postData: { contents: JSON.stringify(body) } }).text) as Record<string, unknown>,
  };
}

const row = (overrides: Partial<MarketPriceRow> = {}): MarketPriceRow => ({
  server: "East/Asia", itemId: "T5_FIBER", city: "Martlock", quality: 1,
  highestBuyPrice: 372, highestBuyObservedAt: "2026-10-28T15:18:17.108Z",
  lowestSellPrice: null, lowestSellObservedAt: null,
  lastIngestedAt: "2026-10-28T15:18:17.108Z", source: "local_collector", ...overrides,
});

const activityRow = (overrides: Partial<MarketActivityRow> = {}): MarketActivityRow => ({
  server: "East/Asia", itemId: "T4_ORE", city: "Bridgewatch", quality: 1, timescale: 1,
  bucketTimestamp: "2026-10-31T18:00:00.000Z", itemAmount: 217, silverAmount: 251720000,
  observedAt: "2026-10-31T18:21:16.506Z", source: "local_collector", ...overrides,
});

test("Apps Script inserts once and deduplicates exact replay", async () => {
  const app = await harness();
  assert.deepEqual(app.post({ secret: "shared-secret", eventId: "a".repeat(64), rows: [row()] }), { ok: true, written: 1, duplicate: false });
  assert.deepEqual(app.post({ secret: "shared-secret", eventId: "a".repeat(64), rows: [row()] }), { ok: true, written: 0, duplicate: true });
  assert.equal(app.table.length, 2);
});

test("Apps Script flushes before fingerprint persistence and lock release", async () => {
  const app = await harness();
  app.post({ secret: "shared-secret", eventId: "a".repeat(64), rows: [row()] });
  assert.deepEqual(app.operations, ["tryLock", "setValues", "flush", "persistFingerprint", "releaseLock"]);
});

test("Apps Script releases the lock and skips the fingerprint when a spreadsheet write fails", async () => {
  const app = await harness({ failSetValues: true });
  assert.equal(app.post({ secret: "shared-secret", eventId: "a".repeat(64), rows: [row()] }).ok, false);
  assert.deepEqual(app.operations, ["tryLock", "setValues", "releaseLock"]);
});

test("Apps Script does not flush duplicate or unchanged events", async () => {
  const app = await harness();
  const body = { secret: "shared-secret", eventId: "a".repeat(64), rows: [row()] };
  app.post(body);
  app.operations.length = 0;
  app.post(body);
  assert.deepEqual(app.operations, ["tryLock", "releaseLock"]);

  app.operations.length = 0;
  app.post({ ...body, eventId: "b".repeat(64) });
  assert.deepEqual(app.operations, ["tryLock", "persistFingerprint", "releaseLock"]);
});

test("Apps Script exposes only filtered Market Prices rows through an authenticated read", async () => {
  const app = await harness();
  app.post({ secret: "shared-secret", eventId: "a".repeat(64), rows: [row()] });
  app.operations.length = 0;
  const result = app.post({ secret: "shared-secret", action: "read", server: "East/Asia", itemIds: ["T5_FIBER"] });
  assert.deepEqual(result, {
    ok: true,
    server: "East/Asia",
    items: [{
      server: "East/Asia", itemId: "T5_FIBER", city: "Martlock", quality: 1,
      highestBuyPrice: 372, highestBuyObservedAt: "2026-10-28T15:18:17.108Z",
      lowestSellPrice: null, lowestSellObservedAt: null,
    }],
  });
  assert.deepEqual(app.operations, ["tryLock", "releaseLock"]);
});

test("Apps Script read returns an empty snapshot without writing", async () => {
  const app = await harness();
  assert.deepEqual(app.post({ secret: "shared-secret", action: "read", server: "East/Asia" }), { ok: true, server: "East/Asia", items: [] });
  assert.equal(app.table.length, 1);
  assert.ok(!app.operations.includes("setValues"));
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

test("Apps Script treats a later batch as a newer snapshot when no scan boundary exists", async () => {
  const app = await harness();
  app.post({ secret: "shared-secret", eventId: "a".repeat(64), rows: [row({ highestBuyPrice: 380 })] });
  app.post({ secret: "shared-secret", eventId: "b".repeat(64), rows: [row({
    highestBuyPrice: 370,
    highestBuyObservedAt: "2026-10-28T15:19:00.000Z",
    lastIngestedAt: "2026-10-28T15:19:00.000Z",
  })] });
  assert.equal(app.table[1]![4], 370);
  assert.equal(app.table[1]![5], "2026-10-28T15:19:00.000Z");
});

test("Apps Script rejects an incorrect shared secret", async () => {
  const app = await harness();
  assert.equal(app.post({ secret: "wrong", eventId: "a".repeat(64), rows: [row()] }).ok, false);
  assert.equal(app.table.length, 1);
});

test("Apps Script rejects a concurrent write when the lock is unavailable", async () => {
  const app = await harness({ lockAvailable: false });
  assert.equal(app.post({ secret: "shared-secret", eventId: "a".repeat(64), rows: [row()] }).ok, false);
  assert.equal(app.table.length, 1);
});

test("Apps Script upserts activity buckets without inflating repeated scans", async () => {
  const app = await harness();
  const first = { secret: "shared-secret", action: "writeActivity", eventId: "a".repeat(64), rows: [activityRow()] };
  assert.deepEqual(app.post(first), { ok: true, written: 1, duplicate: false });
  assert.deepEqual(app.post(first), { ok: true, written: 0, duplicate: true });
  assert.deepEqual(app.post({ ...first, eventId: "b".repeat(64), rows: [activityRow({ itemAmount: 300, observedAt: "2026-10-31T18:30:00.000Z" })] }), { ok: true, written: 1, duplicate: false });
  assert.equal(app.activityTable.length, 2);
  assert.equal(app.activityTable[1]?.[6], 300);
});

test("Apps Script reads activity independently from Market Prices", async () => {
  const app = await harness();
  app.post({ secret: "shared-secret", action: "writeActivity", eventId: "a".repeat(64), rows: [activityRow()] });
  assert.deepEqual(app.post({ secret: "shared-secret", action: "readActivity", server: "East/Asia", itemIds: ["T4_ORE"] }), {
    ok: true, server: "East/Asia", rows: [activityRow()],
  });
  assert.equal(app.table.length, 1);
});

test("Apps Script excludes seed-only prices from the private snapshot", async () => {
  const app = await harness();
  app.table.push(["East/Asia", "T5_FIBER", "Martlock", 1, 100, "2026-10-28T15:00:00.000Z", 110, "2026-10-28T15:00:00.000Z", "2026-10-28T15:00:00.000Z", "aodp_seed"]);
  assert.deepEqual(app.post({ secret: "shared-secret", action: "read", server: "East/Asia", itemIds: ["T5_FIBER"] }), { ok: true, server: "East/Asia", items: [] });
});

test("Apps Script converts seed rows conservatively with independently verified private sides", async () => {
  const app = await harness();
  const seed = () => ["East/Asia", "T5_FIBER", "Martlock", 1, 100, "2026-10-28T15:00:00.000Z", 110, "2026-10-28T15:00:00.000Z", "2026-10-28T15:00:00.000Z", "aodp_seed"] as Array<string | number>;
  app.table.push(seed());
  app.post({ secret: "shared-secret", eventId: "a".repeat(64), rows: [row({ highestBuyPrice: 200, highestBuyObservedAt: "2026-10-28T16:00:00.000Z" })] });
  assert.deepEqual(app.table[1]?.slice(4, 10), [200, "2026-10-28T16:00:00.000Z", "", "", "2026-10-28T15:18:17.108Z", "local_collector"]);
  app.post({ secret: "shared-secret", eventId: "c".repeat(64), rows: [row({ highestBuyPrice: null, highestBuyObservedAt: null, lowestSellPrice: 220, lowestSellObservedAt: "2026-10-28T17:00:00.000Z" })] });
  assert.deepEqual(app.table[1]?.slice(4, 8), [200, "2026-10-28T16:00:00.000Z", 220, "2026-10-28T17:00:00.000Z"]);

  app.table[1] = seed();
  app.post({ secret: "shared-secret", eventId: "b".repeat(64), rows: [row({ highestBuyPrice: null, highestBuyObservedAt: null, lowestSellPrice: 210, lowestSellObservedAt: "2026-10-28T16:00:00.000Z" })] });
  assert.deepEqual(app.table[1]?.slice(4, 10), ["", "", 210, "2026-10-28T16:00:00.000Z", "2026-10-28T15:18:17.108Z", "local_collector"]);
});

test("Apps Script expands Market Activity beyond its initial grid allocation", async () => {
  const app = await harness({ activityMaxRows: 2 });
  const result = app.post({
    secret: "shared-secret", action: "writeActivity", eventId: "a".repeat(64),
    rows: [activityRow(), activityRow({ bucketTimestamp: "2026-10-31T12:00:00.000Z" })],
  });
  assert.deepEqual(result, { ok: true, written: 2, duplicate: false });
  assert.equal(app.activityTable.length, 3);
  assert.ok(app.operations.includes("insertRowsAfter"));
});

test("Apps Script prunes expired activity before expanding the retained grid", async () => {
  const app = await harness({ activityMaxRows: 2 });
  app.activityTable.push(["East/Asia", "T4_ORE", "Bridgewatch", 1, 1, "2026-10-20T00:00:00.000Z", 10, 100, "2026-10-20T01:00:00.000Z", "local_collector"]);
  const result = app.post({
    secret: "shared-secret", action: "writeActivity", eventId: "d".repeat(64),
    rows: [activityRow({ bucketTimestamp: "2026-10-31T18:00:00.000Z" })],
  });
  assert.deepEqual(result, { ok: true, written: 1, duplicate: false });
  assert.equal(app.activityTable.length, 2);
  assert.equal(app.activityTable[1]?.[5], "2026-10-31T18:00:00.000Z");
  assert.ok(app.operations.includes("deleteRows"));
  assert.ok(app.operations.includes("insertRowsAfter"));
});

test("Apps Script accepts 10,000 retained activity rows and rejects unbounded growth", async () => {
  const app = await harness({ activityMaxRows: 10001 });
  for (let index = 0; index < 9999; index += 1) {
    app.activityTable.push([
      "East/Asia", "T4_ORE", "Bridgewatch", 1, 1, new Date(Date.UTC(2026, 9, 31) + index).toISOString(),
      10, 100, "2026-11-01T00:00:00.000Z", "local_collector",
    ]);
  }
  const body = { secret: "shared-secret", action: "writeActivity", rows: [activityRow({ bucketTimestamp: "2026-11-01T00:00:00.000Z" })] };
  assert.deepEqual(app.post({ ...body, eventId: "e".repeat(64) }), { ok: true, written: 1, duplicate: false });
  assert.equal(app.activityTable.length, 10001);
  assert.equal(app.post({ ...body, eventId: "f".repeat(64), rows: [activityRow({ bucketTimestamp: "2026-11-01T00:00:00.001Z" })] }).ok, false);
  assert.equal(app.activityTable.length, 10001);
});
