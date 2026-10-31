import assert from "node:assert/strict";
import { test } from "node:test";
import { createActivityHandler } from "../api/activity.js";

test("GET /activity returns aggregated complete daily history", async () => {
  const rows = [0, 6, 12, 18].map((hour) => ({
    server: "East/Asia", itemId: "T4_ORE", city: "Bridgewatch", quality: 1, timescale: 1,
    bucketTimestamp: `2026-10-30T${String(hour).padStart(2, "0")}:00:00.000Z`, itemAmount: 100, silverAmount: 1000,
    observedAt: "2026-10-31T18:00:00.000Z", source: "local_collector",
  }));
  const handler = createActivityHandler({
    env: { APPS_SCRIPT_URL: "https://script.google.test/exec", APPS_SCRIPT_SECRET: "secret", WEB_ORIGIN: "https://web.test" },
    fetchImpl: async () => Response.json({ ok: true, server: "East/Asia", rows }),
  });
  const response = await handler(new Request("https://receiver.test/activity?server=East%2FAsia&itemIds=T4_ORE", { headers: { origin: "https://web.test" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { server: "East/Asia", items: [{ server: "East/Asia", itemId: "T4_ORE", city: "Bridgewatch", quality: 1, averageDailyUnits: 400, coverageDays: 1, observedAt: "2026-10-31T18:00:00.000Z" }] });
});
