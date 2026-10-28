import type { NormalizedCollectorEvent } from "./market-ingest.js";

export interface AppsScriptResult {
  ok: true;
  written: number;
  duplicate: boolean;
}

export async function persistWithAppsScript(
  event: NormalizedCollectorEvent & { eventId: string },
  config: { url: string; secret: string; fetchImpl?: typeof fetch },
): Promise<AppsScriptResult> {
  const response = await (config.fetchImpl ?? fetch)(config.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: config.secret, ...event }),
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Apps Script returned HTTP ${response.status}.`);
  const result = await response.json() as Partial<AppsScriptResult> & { error?: unknown };
  if (result.ok !== true || !Number.isSafeInteger(result.written) || typeof result.duplicate !== "boolean") throw new Error("Apps Script persistence failed.");
  return result as AppsScriptResult;
}

