import { ALBION_ITEM_IDS } from "./albion-item-map.js";
import { InvalidIngestError, normalizeLocationId } from "./market-ingest.js";

export const MARKET_ACTIVITY_HEADERS = [
  "server", "item_id", "city", "quality", "timescale", "bucket_timestamp",
  "item_amount", "silver_amount", "observed_at", "source",
] as const;

const CITIES: Readonly<Record<string, string>> = {
  "7": "Thetford", "1002": "Lymhurst", "2004": "Bridgewatch", "3008": "Martlock", "4002": "Fort Sterling",
};
const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000;
const TICKS_PER_MILLISECOND = 10_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export interface MarketActivityRow {
  server: "East/Asia";
  itemId: string;
  city: string;
  quality: number;
  timescale: 0 | 1 | 2;
  bucketTimestamp: string;
  itemAmount: number;
  silverAmount: number;
  observedAt: string;
  source: "local_collector";
}

export interface NormalizedMarketHistory {
  received: number;
  rows: MarketActivityRow[];
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) throw new InvalidIngestError(`${name} is invalid.`);
  return value;
}

function timestampFromDotNetTicks(value: unknown, receivedAtMs: number): string {
  const ticks = integer(value, "Timestamp", DOTNET_UNIX_EPOCH_TICKS);
  if (ticks % TICKS_PER_MILLISECOND !== 0) throw new InvalidIngestError("Timestamp must use .NET tick units at millisecond precision.");
  const timestampMs = Math.round((ticks - DOTNET_UNIX_EPOCH_TICKS) / TICKS_PER_MILLISECOND);
  if (!Number.isFinite(timestampMs) || timestampMs > receivedAtMs + 60 * 60 * 1_000 || timestampMs < receivedAtMs - 35 * 24 * 60 * 60 * 1_000) {
    throw new InvalidIngestError("Timestamp is outside the supported market-history window.");
  }
  return new Date(timestampMs).toISOString();
}

export function normalizeCollectorHistory(input: unknown): NormalizedMarketHistory {
  if (!input || typeof input !== "object") throw new InvalidIngestError("Body must be an object.");
  const envelope = input as Record<string, unknown>;
  if (envelope.server !== "East/Asia") throw new InvalidIngestError("server must be East/Asia.");
  if (typeof envelope.receivedAt !== "string" || !Number.isFinite(Date.parse(envelope.receivedAt))) throw new InvalidIngestError("receivedAt is invalid.");
  const receivedAt = new Date(envelope.receivedAt).toISOString();
  const receivedAtMs = Date.parse(receivedAt);
  const payload = envelope.payload as Record<string, unknown> | undefined;
  if (!payload) throw new InvalidIngestError("payload is invalid.");

  const albionId = integer(payload.AlbionId, "AlbionId", 1);
  const itemId = ALBION_ITEM_IDS[albionId];
  if (!itemId) throw new InvalidIngestError("AlbionId is not present in the pinned item mapping.");
  const locationId = normalizeLocationId(payload.LocationId);
  const quality = integer(payload.QualityLevel, "QualityLevel", 1);
  if (quality > 5) throw new InvalidIngestError("QualityLevel is out of range.");
  const timescale = integer(payload.Timescale, "Timescale") as 0 | 1 | 2;
  if (timescale > 2) throw new InvalidIngestError("Timescale is out of range.");
  if (!Array.isArray(payload.MarketHistories) || payload.MarketHistories.length === 0 || payload.MarketHistories.length > 100) {
    throw new InvalidIngestError("MarketHistories must contain 1 to 100 records.");
  }

  const rows = new Map<string, MarketActivityRow>();
  for (const [index, value] of payload.MarketHistories.entries()) {
    if (!value || typeof value !== "object") throw new InvalidIngestError(`MarketHistories ${index} is invalid.`);
    const history = value as Record<string, unknown>;
    const bucketTimestamp = timestampFromDotNetTicks(history.Timestamp, receivedAtMs);
    if (Date.parse(bucketTimestamp) < receivedAtMs - RETENTION_MS) continue;
    const row: MarketActivityRow = {
      server: "East/Asia", itemId, city: CITIES[locationId]!, quality, timescale, bucketTimestamp,
      itemAmount: integer(history.ItemAmount, `MarketHistories ${index} ItemAmount`),
      silverAmount: integer(history.SilverAmount, `MarketHistories ${index} SilverAmount`),
      observedAt: receivedAt, source: "local_collector",
    };
    rows.set(`${itemId}\0${row.city}\0${quality}\0${timescale}\0${bucketTimestamp}`, row);
  }
  if (rows.size === 0) throw new InvalidIngestError("MarketHistories has no records inside the retention window.");
  return { received: payload.MarketHistories.length, rows: [...rows.values()] };
}
