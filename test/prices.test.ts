import assert from "node:assert/strict";
import { test } from "node:test";
import { createPricesHandler } from "../api/prices.js";

const env = {
  APPS_SCRIPT_URL: "https://script.google.test/exec",
  APPS_SCRIPT_SECRET: "shared-secret",
  WEB_ORIGIN: "https://web.example",
  PRICE_CACHE_TTL_SECONDS: "30",
};

const item = {
  server: "East/Asia", itemId: "T5_FIBER", city: "Martlock", quality: 1,
  highestBuyPrice: 372, highestBuyObservedAt: "2026-10-28T15:18:17.108Z",
  lowestSellPrice: null, lowestSellObservedAt: null,
};

test("GET /prices returns a filtered read-only snapshot with CORS and CDN cache headers", async () => {
  let forwarded: Record<string, unknown> | undefined;
  const handler = createPricesHandler({
    env,
    fetchImpl: async (_input, init) => {
      forwarded = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ ok: true, server: "East/Asia", items: [item] });
    },
  });
  const response = await handler(new Request("https://receiver.test/prices?server=East%2FAsia&itemIds=T5_FIBER", { headers: { origin: "https://web.example" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { server: "East/Asia", items: [item] });
  assert.deepEqual(forwarded, { secret: "shared-secret", action: "read", server: "East/Asia", itemIds: ["T5_FIBER"] });
  assert.equal(response.headers.get("access-control-allow-origin"), "https://web.example");
  assert.equal(response.headers.get("vercel-cdn-cache-control"), "public, max-age=30");
});

test("GET /prices distinguishes an empty snapshot from upstream failure", async () => {
  const empty = createPricesHandler({ env, fetchImpl: async () => Response.json({ ok: true, server: "East/Asia", items: [] }) });
  const failed = createPricesHandler({ env, fetchImpl: async () => Response.json({ ok: false, error: "quota" }) });
  const emptyResponse = await empty(new Request("https://receiver.test/prices"));
  const failedResponse = await failed(new Request("https://receiver.test/prices"));
  assert.equal(emptyResponse.status, 200);
  assert.deepEqual(await emptyResponse.json(), { server: "East/Asia", items: [] });
  assert.equal(failedResponse.status, 502);
});

test("GET /prices rejects bad filters and disallowed origins", async () => {
  const handler = createPricesHandler({ env, fetchImpl: async () => { throw new Error("must not call upstream"); } });
  assert.equal((await handler(new Request("https://receiver.test/prices?server=West"))).status, 400);
  assert.equal((await handler(new Request("https://receiver.test/prices?itemIds=bad-id"))).status, 400);
  assert.equal((await handler(new Request("https://receiver.test/prices", { headers: { origin: "https://evil.example" } }))).status, 403);
});

test("public prices endpoint does not accept writes and reports upstream timeouts", async () => {
  const denied = createPricesHandler({ env });
  assert.equal((await denied(new Request("https://receiver.test/prices", { method: "POST" }))).status, 405);
  const timeout = createPricesHandler({ env, fetchImpl: async () => { throw new DOMException("timed out", "TimeoutError"); } });
  assert.equal((await timeout(new Request("https://receiver.test/prices"))).status, 502);
});
