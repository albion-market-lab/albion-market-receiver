import { readFromAppsScript } from "../src/apps-script-client.js";

const ITEM_ID = /^[A-Z0-9_]+(?:@[1-4])?$/;
const MAX_ITEM_IDS = 100;

interface HandlerOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

function json(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

export function createPricesHandler({ fetchImpl, env = process.env }: HandlerOptions = {}) {
  return async function handle(request: Request): Promise<Response> {
    const scriptUrl = env.APPS_SCRIPT_URL;
    const secret = env.APPS_SCRIPT_SECRET;
    const webOrigin = env.WEB_ORIGIN;
    const ttl = Number(env.PRICE_CACHE_TTL_SECONDS ?? 60);
    if (!scriptUrl || !secret || !webOrigin || !Number.isInteger(ttl) || ttl < 1 || ttl > 300) return json(503, { message: "Service unavailable" });

    const cors = { "access-control-allow-origin": webOrigin, "access-control-allow-methods": "GET, OPTIONS", "vary": "origin" };
    const origin = request.headers.get("origin");
    if (origin && origin !== webOrigin) return json(403, { message: "Origin not allowed" });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-max-age": "600" } });
    if (request.method !== "GET") return json(405, { message: "Method not allowed" }, cors);

    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "server" && key !== "itemIds")) return json(400, { message: "Unknown query parameter" }, cors);
    const server = url.searchParams.get("server") ?? "East/Asia";
    if (server !== "East/Asia") return json(400, { message: "server must be East/Asia" }, cors);
    const itemIds = url.searchParams.getAll("itemIds").flatMap((value) => value.split(",")).map((value) => value.trim());
    if (itemIds.some((itemId) => !ITEM_ID.test(itemId)) || itemIds.length > MAX_ITEM_IDS) return json(400, { message: `itemIds must contain at most ${MAX_ITEM_IDS} valid IDs` }, cors);
    const uniqueItemIds = [...new Set(itemIds)];

    try {
      const snapshot = await readFromAppsScript(
        { server: "East/Asia", ...(uniqueItemIds.length ? { itemIds: uniqueItemIds } : {}) },
        { url: scriptUrl, secret, ...(fetchImpl ? { fetchImpl } : {}) },
      );
      return json(200, snapshot, {
        ...cors,
        "cache-control": "public, max-age=0, must-revalidate",
        "vercel-cdn-cache-control": `public, max-age=${ttl}`,
      });
    } catch {
      console.error("Price snapshot read failed.");
      return json(502, { message: "Price snapshot unavailable" }, cors);
    }
  };
}

export default { fetch: createPricesHandler() };
