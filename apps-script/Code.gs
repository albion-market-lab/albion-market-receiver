const MARKET_SHEET = "Market Prices";
const HEADERS = [
  "server", "item_id", "city", "quality", "highest_buy_price", "highest_buy_observed_at",
  "lowest_sell_price", "lowest_sell_observed_at", "last_ingested_at", "source",
];
const RECENT_EVENT_LIMIT = 100;
const READ_ITEM_LIMIT = 100;

function response(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

function keyOf(row) {
  return [row[0], row[1], row[2], row[3]].join("\u0000");
}

function validateRow(row) {
  if (!row || row.server !== "East/Asia" || typeof row.itemId !== "string" || !row.itemId || typeof row.city !== "string" || !row.city) throw new Error("Invalid normalized row.");
  if (!Number.isInteger(row.quality) || row.quality < 1 || row.quality > 5) throw new Error("Invalid quality.");
  if (row.highestBuyPrice !== null && (!Number.isSafeInteger(row.highestBuyPrice) || row.highestBuyPrice <= 0)) throw new Error("Invalid BUY price.");
  if (row.lowestSellPrice !== null && (!Number.isSafeInteger(row.lowestSellPrice) || row.lowestSellPrice <= 0)) throw new Error("Invalid SELL price.");
  if (row.source !== "local_collector" || typeof row.lastIngestedAt !== "string") throw new Error("Invalid source or timestamp.");
}

function toValues(row) {
  validateRow(row);
  return [
    row.server, row.itemId, row.city, row.quality,
    row.highestBuyPrice === null ? "" : row.highestBuyPrice,
    row.highestBuyObservedAt || "",
    row.lowestSellPrice === null ? "" : row.lowestSellPrice,
    row.lowestSellObservedAt || "",
    row.lastIngestedAt,
    row.source,
  ];
}

function marketSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MARKET_SHEET);
  if (!sheet) throw new Error("Market Prices sheet is missing.");
  const headers = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  if (JSON.stringify(headers) !== JSON.stringify(HEADERS)) throw new Error("Market Prices headers do not match.");
  return sheet;
}

function readSnapshot(input) {
  if (input.server !== "East/Asia" || (input.itemIds !== undefined && (!Array.isArray(input.itemIds) || input.itemIds.length < 1 || input.itemIds.length > READ_ITEM_LIMIT))) throw new Error("Invalid read request.");
  if (input.itemIds && input.itemIds.some((itemId) => typeof itemId !== "string" || !/^[A-Z0-9_]+(?:@[1-4])?$/.test(itemId))) throw new Error("Invalid itemIds.");
  const sheet = marketSheet();
  const rowCount = sheet.getLastRow() - 1;
  if (rowCount > 2000) throw new Error("Market snapshot is too large.");
  const wanted = input.itemIds ? new Set(input.itemIds) : null;
  const values = rowCount > 0 ? sheet.getRange(2, 1, rowCount, HEADERS.length).getValues() : [];
  const items = values.filter((row) => row[0] === input.server && (!wanted || wanted.has(row[1]))).map((row) => {
    if (typeof row[1] !== "string" || typeof row[2] !== "string" || !Number.isInteger(row[3]) || row[3] < 1 || row[3] > 5) throw new Error("Invalid Market Prices row.");
    if ((row[4] !== "" && (!Number.isSafeInteger(row[4]) || row[4] <= 0)) || (row[6] !== "" && (!Number.isSafeInteger(row[6]) || row[6] <= 0))) throw new Error("Invalid Market Prices price.");
    return {
      server: row[0], itemId: row[1], city: row[2], quality: row[3],
      highestBuyPrice: row[4] === "" ? null : row[4], highestBuyObservedAt: row[5] || null,
      lowestSellPrice: row[6] === "" ? null : row[6], lowestSellObservedAt: row[7] || null,
    };
  });
  return response({ ok: true, server: input.server, items: items });
}

function doPost(event) {
  const lock = LockService.getScriptLock();
  try {
    const input = JSON.parse(event.postData.contents);
    const expectedSecret = PropertiesService.getScriptProperties().getProperty("INGEST_SECRET");
    if (!expectedSecret || input.secret !== expectedSecret) throw new Error("Unauthorized.");
    if (!lock.tryLock(10000)) throw new Error("Ingest is busy.");
    if (input.action === "read") return readSnapshot(input);
    if (!/^[a-f0-9]{64}$/.test(input.eventId) || !Array.isArray(input.rows) || input.rows.length === 0) throw new Error("Invalid request.");

    const properties = PropertiesService.getScriptProperties();
    const recent = JSON.parse(properties.getProperty("RECENT_EVENT_IDS") || "[]");
    if (recent.includes(input.eventId)) return response({ ok: true, written: 0, duplicate: true });

    const sheet = marketSheet();

    const values = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues() : [];
    const indexes = new Map(values.map((row, index) => [keyOf(row), index]));
    let written = 0;
    input.rows.forEach((incoming) => {
      const next = toValues(incoming);
      const key = keyOf(next);
      const index = indexes.get(key);
      if (index === undefined) {
        indexes.set(key, values.length);
        values.push(next);
        written += 1;
        return;
      }

      const current = values[index];
      let changed = false;
      if (next[5] && (!current[5] || next[5] > current[5])) {
        current[4] = next[4];
        current[5] = next[5];
        changed = true;
      }
      if (next[7] && (!current[7] || next[7] > current[7])) {
        current[6] = next[6];
        current[7] = next[7];
        changed = true;
      }
      if (next[8] > current[8]) {
        current[8] = next[8];
        changed = true;
      }
      if (changed) written += 1;
    });

    if (written > 0) {
      sheet.getRange(2, 1, values.length, HEADERS.length).setValues(values);
      SpreadsheetApp.flush();
    }
    recent.push(input.eventId);
    properties.setProperty("RECENT_EVENT_IDS", JSON.stringify(recent.slice(-RECENT_EVENT_LIMIT)));
    return response({ ok: true, written, duplicate: false });
  } catch (error) {
    console.error("Market upsert failed: " + error.message);
    return response({ ok: false, error: error.message });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

