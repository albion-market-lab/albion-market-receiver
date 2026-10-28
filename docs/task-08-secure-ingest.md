# Task 08 — Vercel ingest and Apps Script upsert

Status: **PASS — production deployment and live gameplay verification completed on 28 October 2026**.

## Architecture

```text
Mac M1: Albion Online -> unchanged Albion Data Client
                              |
                              | POST /marketorders.ingest
                              v
Vercel Hobby: validate -> normalize -> aggregate -> fingerprint
                              |
                              | shared secret in JSON over HTTPS
                              v
Google Apps Script: LockService -> batch upsert -> Market Prices
```

Normal operation needs no local listener, database, relay, or background service. Task 07's localhost listener remains only as a diagnostic PoC tool.

The public collector endpoint intentionally has no authentication for this personal MVP because the collector cannot attach custom headers. It enforces POST, JSON content type, a 1 MiB body limit, and strict collector-payload validation. The Vercel-to-Apps-Script secret is stored only in Vercel environment variables and Apps Script Properties.

## Data behavior

- Snapshot key: `(server,item_id,city,quality)`.
- `request` selects the highest BUY; `offer` selects the lowest SELL.
- Raw `UnitPriceSilver` is divided by 10,000.
- BUY and SELL values and timestamps update independently.
- Missing sides remain empty, never zero.
- Older received timestamps do not overwrite newer timestamps.
- Exact raw-payload replay is fingerprinted and ignored while its ID remains in the latest 100 processed event IDs.
- Apps Script uses `LockService` around fingerprint check, read, merge, and write.
- The table is persisted with one `setValues` call per changed event.
- `source` remains `local_collector`.

The collector payload does not include an observation timestamp. Vercel's HTTP receipt time is therefore only a proxy for observation time, not proof that the packet was freshly captured. A replay outside the 100-fingerprint window can refresh that proxy timestamp. This is an explicit MVP limitation; no timestamp is invented from order expiry.

## Automated validation

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

Tests execute the Apps Script source with in-memory mocks and cover insert, exact replay, BUY/SELL preservation, older-event protection, incorrect secret, real collector fixtures, malformed/oversized requests, and Apps Script failure.

## Deploy Google Apps Script

1. Open the existing `db-albion-market-lab` spreadsheet.
2. Open **Extensions -> Apps Script** so the script is container-bound to that spreadsheet.
3. Replace `Code.gs` with `apps-script/Code.gs` from this repository.
4. Enable the manifest in project settings and replace it with `apps-script/appsscript.json`.
5. In **Project Settings -> Script Properties**, add `INGEST_SECRET` with a long random value.
6. Select **Deploy -> New deployment -> Web app**.
7. Execute as the spreadsheet owner and allow access to anyone who has the URL. The shared secret still gates writes inside `doPost`.
8. Authorize spreadsheet access when Google prompts.
9. Copy the `/exec` deployment URL; do not commit it.

Apps Script returns JSON with `{ok,written,duplicate}`. Apps Script web apps may return HTTP 200 for application errors, so the Vercel function checks `ok` and returns HTTP 502 when persistence fails.

## Deploy Vercel Hobby

Vercel Hobby is suitable only for this personal, noncommercial project. Quota exhaustion and temporary downtime are accepted. Do not enable paid spending or upgrade the project.

The GitHub repository belongs to an organization, which Hobby cannot connect to directly. Deploy from the local checkout with Vercel CLI:

```bash
cd "$HOME/Documents/market-albion-lab/albion-market-receiver"
npx vercel login
npx vercel link
npx vercel env add APPS_SCRIPT_URL production --visibility config
npx vercel env add APPS_SCRIPT_SECRET production --visibility secret
npx vercel --prod
```

Enter the Apps Script `/exec` URL and the same script-property secret only when prompted. Environment changes require a new deployment. The route in `vercel.json` exposes the collector-compatible endpoint:

```text
POST https://<VERCEL_DOMAIN>/marketorders.ingest
```

No spreadsheet ID, Google service account, GCP project, Cloud Run service, Cloud Function, or Secret Manager is required.

## Configure the unchanged collector

Only after Vercel and Apps Script are deployed:

```bash
cd "$HOME/Documents/market-albion-lab/albiondata-client"
sudo ./albiondata-client-executable \
  -i https://albion-market-receiver.vercel.app \
  -p ""
```

Do not use the bundled `run.command`, `-d`, a community endpoint, or a localhost relay for normal Task 08 operation.

## Live verification checklist

Live verification completed on 28 October 2026. The unchanged v0.1.61 AMD64 collector ran on an Apple Silicon Mac through Rosetta, posted live East/Asia market orders directly to Vercel, received successful ingest responses, and updated `Market Prices` through Apps Script.

Sanitized evidence:

- Location `3008` mapped to Martlock.
- Seven snapshot keys were updated during the observed session.
- A quality-1 `T8_ORE` row preserved both sides independently: BUY `7134` observed at `2026-10-28T16:38:51.618Z` and SELL `7181` observed at `2026-10-28T16:38:51.841Z`.
- The row retained `source = local_collector` and used the later side timestamp for `last_ingested_at`.
- An exact fixture replay against production returned `duplicate: true`, wrote zero rows, and did not create a duplicate snapshot row.

The collector also posts festivities and market-history event types. Those unsupported routes return HTTP 404 by design; successful `marketorders.ingest` responses are the relevant Task 08 evidence.

Reproduction checklist:

1. Confirm `Market Prices` has the expected ten headers and preserve a local backup.
2. Start the collector with the Vercel base URL.
3. Open one Albion East/Asia market item with BUY and SELL orders.
4. Confirm collector logs show HTTP 200 from the Vercel destination.
5. Confirm exactly one row per `(East/Asia,item,city,quality)` in `Market Prices`.
6. Record the side-specific prices and timestamps.
7. Replay the exact captured JSON against `/marketorders.ingest`.
8. Confirm no duplicate row and no timestamp/value change; Vercel should report `duplicate: true`.
9. Test a newer opposite-side observation and confirm the original side remains intact.
10. Stop the collector. Existing Sheet rows must remain unchanged and readable.

Keep Vercel logs, Apps Script execution logs, raw payloads, URLs, and secrets local. Never commit account identifiers, raw captures, or credentials.

## Operational risks

- The unauthenticated collector endpoint can consume free quotas if its URL is abused. Strict validation limits work per malformed request but cannot eliminate denial-of-quota risk.
- Apps Script and Vercel quotas can cause temporary failures. The collector does not guarantee retry, so another manual scan may be needed.
- Apps Script rewrites the current snapshot table in one batch. This is simple and atomic under the script lock, but not intended for high-volume multi-user ingestion.
- The 100-event fingerprint window bounds Script Properties usage. Very old exact replays are not distinguishable from fresh identical payloads.
- Receipt time is a freshness proxy because the collector supplies no observation timestamp.

Task 09 read endpoints and frontend freshness UX are not included.
