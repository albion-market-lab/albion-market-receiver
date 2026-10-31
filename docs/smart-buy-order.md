# Smart Buy Order — market activity

## Verified collector contract

Albion Data Client `0.1.61` posts public history events to `/markethistories.ingest`. Its tagged source defines `AlbionId`, `LocationId`, `QualityLevel`, `Timescale`, and `MarketHistories[]` with `ItemAmount`, `SilverAmount`, and `Timestamp`.

The live Mac M1 capture on 2026-11-01 verified both `Timescale: 0` and `Timescale: 1` payloads for `AlbionId: 1000` at Bridgewatch. The value maps to `T4_ORE` in `ao-data/ao-bin-dumps` commit `1a469e53de028c5f85cdd80505f10cbd0a2515cf`. Runtime timestamps are .NET ticks; `639290664000000000` converts to `2026-10-31T18:00:00.000Z`. The seven-day view uses six-hour buckets.

The committed fixture is a sanitized subset of that capture. Raw samples remain ignored under `var/collector-events/`.

## Storage

Create a separate Google Sheet tab named `Market Activity` with these exact headers:

```text
server,item_id,city,quality,timescale,bucket_timestamp,item_amount,silver_amount,observed_at,source
```

Deploy the local `apps-script/Code.gs` update only after the sheet exists. Activity keys are `server + item + city + quality + timescale + bucket timestamp`. Repeated scans replace a bucket with its newer observation and never add its volume. Writes update contiguous changed ranges and append new buckets instead of rewriting the whole sheet; rows older than seven days are pruned during activity writes. The script expands the tab when an append exceeds its current grid allocation and rejects retained data above 10,000 rows.

The public `/activity` endpoint reads only daily-view (`Timescale: 1`) buckets. Collector evidence shows these six-hour timestamps are interval starts: a live 18:00 bucket continued changing after 18:00. A UTC day therefore counts only after all four 00:00, 06:00, 12:00, and 18:00 buckets exist and the final interval has ended at 00:00 the next day. Missing history is omitted, not converted to zero sales.

`/prices` exposes only rows marked `local_collector`. A legacy `aodp_seed` row remains hidden until a new private scan replaces it. That first private observation clears the unverified opposite side; later private BUY and SELL scans may then populate both sides independently. Historical seed rows are retained rather than migrated or deleted.

## Private collection

The collector command remains private-only:

```bash
sudo ./albiondata-client-executable \
  -i https://albion-market-receiver.vercel.app \
  -p ""
```

Before production deployment, use localhost and verify the payload as documented in `mac-m1-poc.md`. Do not add an AODP community destination.

## Live verification checklist

1. Deploy the Apps Script and receiver changes only after review.
2. Scan BUY/SELL orders and both 24-hour and 7-day market graphs for one item.
3. Confirm `Market Prices` and `Market Activity` update independently.
4. Rescan the same graph and verify bucket count and volume do not increase.
5. Compare four six-hour buckets with one complete UTC day in the in-game graph.
6. Call `/prices` and `/activity` for the canonical item ID.
7. Confirm collector sockets target only the configured private receiver.

Market sales volume is an activity proxy, not a promise that a specific Buy Order fills within 48 hours. Order-book competition is not observable. The initial fixed policy is defined by `BEST_VALUE_POLICY` in the calculator and requires later calibration from real outcomes.
