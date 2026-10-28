export const MARKET_PRICE_HEADERS = [
  "server", "item_id", "city", "quality", "highest_buy_price", "highest_buy_observed_at",
  "lowest_sell_price", "lowest_sell_observed_at", "last_ingested_at", "source",
] as const;

const CITIES: Record<string, string> = {
  "7": "Thetford",
  "1002": "Lymhurst",
  "2004": "Bridgewatch",
  "3008": "Martlock",
  "4002": "Fort Sterling",
};

export interface MarketPriceRow {
  server: "East/Asia";
  itemId: string;
  city: string;
  quality: number;
  highestBuyPrice: number | null;
  highestBuyObservedAt: string | null;
  lowestSellPrice: number | null;
  lowestSellObservedAt: string | null;
  lastIngestedAt: string;
  source: "local_collector";
}

interface CollectorOrder {
  ItemTypeId: string;
  LocationId: string;
  QualityLevel: number;
  EnchantmentLevel: number;
  UnitPriceSilver: number;
  Amount: number;
  AuctionType: "request" | "offer";
}

export interface CollectorEnvelope {
  server: "East/Asia";
  receivedAt: string;
  payload: { Orders: CollectorOrder[] };
}

export class InvalidIngestError extends Error {}

export interface NormalizedCollectorEvent {
  received: number;
  rows: MarketPriceRow[];
}

function requiredInteger(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new InvalidIngestError(`${name} is invalid.`);
  return value as number;
}

function parseEnvelope(value: unknown): CollectorEnvelope {
  if (!value || typeof value !== "object") throw new InvalidIngestError("Body must be an object.");
  const envelope = value as Record<string, unknown>;
  if (envelope.server !== "East/Asia") throw new InvalidIngestError("server must be East/Asia.");
  if (typeof envelope.receivedAt !== "string" || !Number.isFinite(Date.parse(envelope.receivedAt))) throw new InvalidIngestError("receivedAt is invalid.");
  const payload = envelope.payload as { Orders?: unknown } | undefined;
  if (!payload || !Array.isArray(payload.Orders) || payload.Orders.length === 0) throw new InvalidIngestError("payload.Orders must be non-empty.");

  const orders = payload.Orders.map((value, index): CollectorOrder => {
    if (!value || typeof value !== "object") throw new InvalidIngestError(`Order ${index} is invalid.`);
    const order = value as Record<string, unknown>;
    if (typeof order.ItemTypeId !== "string" || !/^[A-Z0-9_]+(?:@[1-4])?$/.test(order.ItemTypeId)) throw new InvalidIngestError(`Order ${index} ItemTypeId is invalid.`);
    if (typeof order.LocationId !== "string" || !CITIES[order.LocationId]) throw new InvalidIngestError(`Order ${index} LocationId is invalid.`);
    if (order.AuctionType !== "request" && order.AuctionType !== "offer") throw new InvalidIngestError(`Order ${index} AuctionType is invalid.`);
    return {
      ItemTypeId: order.ItemTypeId,
      LocationId: order.LocationId,
      QualityLevel: requiredInteger(order.QualityLevel, `Order ${index} QualityLevel`, 1),
      EnchantmentLevel: requiredInteger(order.EnchantmentLevel, `Order ${index} EnchantmentLevel`),
      UnitPriceSilver: requiredInteger(order.UnitPriceSilver, `Order ${index} UnitPriceSilver`, 1),
      Amount: requiredInteger(order.Amount, `Order ${index} Amount`, 1),
      AuctionType: order.AuctionType,
    };
  });
  if (orders.some(({ QualityLevel }) => QualityLevel > 5) || orders.some(({ EnchantmentLevel }) => EnchantmentLevel > 4)) throw new InvalidIngestError("QualityLevel or EnchantmentLevel is out of range.");
  return { server: "East/Asia", receivedAt: new Date(envelope.receivedAt).toISOString(), payload: { Orders: orders } };
}

function itemId(order: CollectorOrder): string {
  const suffix = order.ItemTypeId.match(/@(\d)$/)?.[1];
  if (suffix !== undefined && Number(suffix) !== order.EnchantmentLevel) throw new InvalidIngestError("Item enchantment suffix conflicts with EnchantmentLevel.");
  return suffix === undefined && order.EnchantmentLevel > 0 ? `${order.ItemTypeId}@${order.EnchantmentLevel}` : order.ItemTypeId;
}

const keyOf = ({ server, itemId, city, quality }: Pick<MarketPriceRow, "server" | "itemId" | "city" | "quality">) => `${server}\0${itemId}\0${city}\0${quality}`;

export function normalizeCollectorEvent(input: unknown): NormalizedCollectorEvent {
  const envelope = parseEnvelope(input);
  const incoming = new Map<string, MarketPriceRow>();
  for (const order of envelope.payload.Orders) {
    const base: MarketPriceRow = {
      server: envelope.server, itemId: itemId(order), city: CITIES[order.LocationId]!, quality: order.QualityLevel,
      highestBuyPrice: null, highestBuyObservedAt: null, lowestSellPrice: null, lowestSellObservedAt: null,
      lastIngestedAt: envelope.receivedAt, source: "local_collector",
    };
    const key = keyOf(base);
    const row = incoming.get(key) ?? base;
    const price = Math.trunc(order.UnitPriceSilver / 10_000);
    if (price <= 0) throw new InvalidIngestError("Normalized UnitPriceSilver must be positive.");
    if (order.AuctionType === "request" && (row.highestBuyPrice === null || price > row.highestBuyPrice)) {
      row.highestBuyPrice = price;
      row.highestBuyObservedAt = envelope.receivedAt;
    }
    if (order.AuctionType === "offer" && (row.lowestSellPrice === null || price < row.lowestSellPrice)) {
      row.lowestSellPrice = price;
      row.lowestSellObservedAt = envelope.receivedAt;
    }
    incoming.set(key, row);
  }

  return { received: envelope.payload.Orders.length, rows: [...incoming.values()] };
}

