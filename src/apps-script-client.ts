import type { NormalizedCollectorEvent } from "./market-ingest.js";
import type { MarketActivityRow, NormalizedMarketHistory } from "./market-history.js";

export interface AppsScriptResult {
  ok: true;
  written: number;
  duplicate: boolean;
}

export interface PublicMarketPrice {
  server: "East/Asia";
  itemId: string;
  city: string;
  quality: number;
  highestBuyPrice: number | null;
  highestBuyObservedAt: string | null;
  lowestSellPrice: number | null;
  lowestSellObservedAt: string | null;
}

export interface PriceSnapshot {
  server: "East/Asia";
  items: PublicMarketPrice[];
}

export interface MarketActivitySnapshot {
  server: "East/Asia";
  rows: MarketActivityRow[];
}

async function post(config: { url: string; secret: string; fetchImpl?: typeof fetch }, body: object): Promise<unknown> {
  const response = await (config.fetchImpl ?? fetch)(config.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: config.secret, ...body }),
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Apps Script returned HTTP ${response.status}.`);
  return response.json();
}

export async function persistWithAppsScript(
  event: NormalizedCollectorEvent & { eventId: string },
  config: { url: string; secret: string; fetchImpl?: typeof fetch },
): Promise<AppsScriptResult> {
  const result = await post(config, event) as Partial<AppsScriptResult> & { error?: unknown };
  if (result.ok !== true || !Number.isSafeInteger(result.written) || typeof result.duplicate !== "boolean") throw new Error("Apps Script persistence failed.");
  return result as AppsScriptResult;
}

export async function persistActivityWithAppsScript(
  event: NormalizedMarketHistory & { eventId: string },
  config: { url: string; secret: string; fetchImpl?: typeof fetch },
): Promise<AppsScriptResult> {
  const result = await post(config, { action: "writeActivity", ...event }) as Partial<AppsScriptResult>;
  if (result.ok !== true || !Number.isSafeInteger(result.written) || typeof result.duplicate !== "boolean") throw new Error("Apps Script activity persistence failed.");
  return result as AppsScriptResult;
}

export async function readFromAppsScript(
  filters: { server: "East/Asia"; itemIds?: string[] },
  config: { url: string; secret: string; fetchImpl?: typeof fetch },
): Promise<PriceSnapshot> {
  const result = await post(config, { action: "read", ...filters }) as { ok?: unknown; server?: unknown; items?: unknown };
  if (result.ok !== true || result.server !== "East/Asia" || !Array.isArray(result.items)) throw new Error("Apps Script read failed.");
  for (const item of result.items) {
    const row = item as Partial<PublicMarketPrice>;
    const validTimestamp = (value: unknown) => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
    if (row.server !== "East/Asia" || typeof row.itemId !== "string" || !/^[A-Z0-9_]+(?:@[1-4])?$/.test(row.itemId) || typeof row.city !== "string" || !row.city || !Number.isInteger(row.quality) || row.quality! < 1 || row.quality! > 5 || (row.highestBuyPrice !== null && (!Number.isSafeInteger(row.highestBuyPrice) || row.highestBuyPrice! <= 0)) || (row.lowestSellPrice !== null && (!Number.isSafeInteger(row.lowestSellPrice) || row.lowestSellPrice! <= 0)) || !validTimestamp(row.highestBuyObservedAt) || !validTimestamp(row.lowestSellObservedAt)) throw new Error("Apps Script returned an invalid price row.");
  }
  return { server: "East/Asia", items: result.items as PublicMarketPrice[] };
}

export async function readActivityFromAppsScript(
  filters: { server: "East/Asia"; itemIds?: string[] },
  config: { url: string; secret: string; fetchImpl?: typeof fetch },
): Promise<MarketActivitySnapshot> {
  const result = await post(config, { action: "readActivity", ...filters }) as { ok?: unknown; server?: unknown; rows?: unknown };
  if (result.ok !== true || result.server !== "East/Asia" || !Array.isArray(result.rows)) throw new Error("Apps Script activity read failed.");
  for (const value of result.rows) {
    const row = value as Partial<MarketActivityRow>;
    if (row.server !== "East/Asia" || typeof row.itemId !== "string" || typeof row.city !== "string" || !Number.isInteger(row.quality)
      || !Number.isInteger(row.timescale) || !Number.isSafeInteger(row.itemAmount) || !Number.isSafeInteger(row.silverAmount)
      || typeof row.bucketTimestamp !== "string" || !Number.isFinite(Date.parse(row.bucketTimestamp))
      || typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt)) || row.source !== "local_collector") {
      throw new Error("Apps Script returned an invalid activity row.");
    }
  }
  return { server: "East/Asia", rows: result.rows as MarketActivityRow[] };
}

