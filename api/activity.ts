import { readActivityFromAppsScript } from "../src/apps-script-client.js";

const ITEM_ID = /^[A-Z0-9_]+(?:@[1-4])?$/;
const MAX_ITEM_IDS = 100;

export interface PublicMarketActivity {
  server: "East/Asia";
  itemId: string;
  city: string;
  quality: number;
  averageDailyUnits: number;
  coverageDays: number;
  observedAt: string;
}

const json = (status: number, body: unknown, headers: HeadersInit = {}) => Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

export function aggregateDailyActivity(rows: Awaited<ReturnType<typeof readActivityFromAppsScript>>["rows"]): PublicMarketActivity[] {
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.timescale !== 1) continue;
    const key = `${row.server}\0${row.itemId}\0${row.city}\0${row.quality}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].flatMap((group) => {
    const days = new Map<string, typeof group>();
    for (const row of group) {
      const day = row.bucketTimestamp.slice(0, 10);
      days.set(day, [...(days.get(day) ?? []), row]);
    }
    const complete = [...days.values()].filter((day) => {
      const hours = new Set(day.map(({ bucketTimestamp }) => new Date(bucketTimestamp).getUTCHours()));
      return day.length === 4 && [0, 6, 12, 18].every((hour) => hours.has(hour));
    });
    if (complete.length === 0) return [];
    const total = complete.flat().reduce((sum, { itemAmount }) => sum + itemAmount, 0);
    const first = group[0]!;
    return [{
      server: first.server, itemId: first.itemId, city: first.city, quality: first.quality,
      averageDailyUnits: total / complete.length,
      coverageDays: complete.length,
      observedAt: group.reduce((latest, row) => row.observedAt > latest ? row.observedAt : latest, first.observedAt),
    }];
  });
}

export function createActivityHandler({ fetchImpl, env = process.env }: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}) {
  return async function handle(request: Request): Promise<Response> {
    const scriptUrl = env.APPS_SCRIPT_URL;
    const secret = env.APPS_SCRIPT_SECRET;
    const webOrigin = env.WEB_ORIGIN;
    if (!scriptUrl || !secret || !webOrigin) return json(503, { message: "Service unavailable" });
    const cors = { "access-control-allow-origin": webOrigin, "access-control-allow-methods": "GET, OPTIONS", "vary": "origin" };
    const origin = request.headers.get("origin");
    if (origin && origin !== webOrigin) return json(403, { message: "Origin not allowed" });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json(405, { message: "Method not allowed" }, cors);
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "server" && key !== "itemIds")) return json(400, { message: "Unknown query parameter" }, cors);
    const server = url.searchParams.get("server") ?? "East/Asia";
    const itemIds = url.searchParams.getAll("itemIds").flatMap((value) => value.split(",")).map((value) => value.trim());
    if (server !== "East/Asia" || itemIds.some((itemId) => !ITEM_ID.test(itemId)) || itemIds.length > MAX_ITEM_IDS) return json(400, { message: "Invalid filters" }, cors);
    const uniqueItemIds = [...new Set(itemIds)];
    try {
      const snapshot = await readActivityFromAppsScript(
        { server: "East/Asia", ...(uniqueItemIds.length ? { itemIds: uniqueItemIds } : {}) },
        { url: scriptUrl, secret, ...(fetchImpl ? { fetchImpl } : {}) },
      );
      return json(200, { server: snapshot.server, items: aggregateDailyActivity(snapshot.rows) }, cors);
    } catch {
      console.error("Market activity read failed.");
      return json(502, { message: "Market activity unavailable" }, cors);
    }
  };
}

export default { fetch: createActivityHandler() };
