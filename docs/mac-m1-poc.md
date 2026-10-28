# Mac M1 private-only collector PoC

Status: **PASS** for Task 07. Real BUY and SELL market events were received locally, and process-level socket inspection during another live scan showed only loopback connections to the private listener.

## Verified local collector

- Expected workspace path: `$HOME/Documents/market-albion-lab/albiondata-client/albiondata-client-executable` (adjust `WORKSPACE` below if the workspace is elsewhere).
- Placement: alongside this repository; it is not copied into or tracked by the receiver.
- Embedded version: `0.1.61`.
- Architecture: Mach-O `x86_64`; the host is `arm64` and Rosetta 2 is installed, so macOS runs this release through Rosetta.
- The downloaded `run.command` is unsafe for this PoC because it starts the default community destination without `-i`.
- In this macOS build, `-h`/`--help` did not exit or print usage. Supported flags were therefore verified against `client/config.go` at upstream tag `0.1.61` and embedded strings in the binary.

Upstream routing at tag `0.1.61` sends public market events to every `-i` target and also to every `-p` target. An empty `-p` target is skipped. The HTTP uploader posts to `<base>/<topic>`, and the market topic is `marketorders.ingest`. Therefore the private-only market route is:

```text
-i http://127.0.0.1:8787 -p ""
  -> POST http://127.0.0.1:8787/marketorders.ingest
```

Do not add `-d`: it disables all uploads, including localhost. The client also contains an automatic GitHub release updater; that may create non-market outbound traffic. The live check must distinguish updater traffic from market ingest and must show no market POST to AODP/community hosts.

## Build and start the listener

```bash
WORKSPACE="${WORKSPACE:-$HOME/Documents/market-albion-lab}"
cd "$WORKSPACE/albion-market-receiver"
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm start:poc
```

The listener binds only to `127.0.0.1:8787`, accepts only `POST /marketorders.ingest` JSON, caps bodies at 1 MiB, and stores at most three raw local samples per process under ignored `var/collector-events/`. Sample names combine receipt time with a random UUID, existing files are never overwritten or deleted, and valid events still receive HTTP 200 after the per-session sample limit. Stop it with `Ctrl-C`.

## Start the collector only after the listener is ready

Open a second Terminal:

```bash
WORKSPACE="${WORKSPACE:-$HOME/Documents/market-albion-lab}"
cd "$WORKSPACE/albiondata-client"
sudo ./albiondata-client-executable -i http://127.0.0.1:8787 -p ""
```

Do not use the bundled `run.command`. Because the collector runs through `sudo`, inspect it from a third Terminal with `sudo` too:

```bash
COLLECTOR_PID="$(pgrep -f '^./albiondata-client-executable ' | head -1)"
sudo lsof -nP -a -p "$COLLECTOR_PID" -i
```

The expected ingest connection is loopback `127.0.0.1:8787`. A GitHub connection may be the updater; any AODP/community connection carrying market ingest fails the private-only requirement. Save the command output for the PoC evidence, but do not commit logs containing unrelated addresses.

`lsof` is a point-in-time socket view: it can miss short-lived connections between samples and does not reveal HTTP request bodies. Repeat it in a loop while actively browsing the market, and correlate it with the collector log plus the verified `-i`/`-p` source behavior. A stronger future audit can use a process-aware firewall or packet capture, but raw packet captures must remain local and must not be committed.

Every reproduction needs host access and manual gameplay. **MANUAL VERIFICATION REQUIRED:** confirm the listener is already running, browse an actual market item, observe a local receipt, and inspect outbound connections during that same activity. Unit tests cannot prove packet capture or absence of external traffic.

## Store evidence locally

Keep evidence in the repository's ignored `var/` directory with owner-only permissions:

```bash
cd "$WORKSPACE/albion-market-receiver"
umask 077
mkdir -p var/poc-evidence
while true; do
  date -u
  sudo lsof -nP -a -p "$COLLECTOR_PID" -i
  sleep 1
done | tee var/poc-evidence/collector-sockets.txt
```

Stop the loop with `Ctrl-C`. Collector logs can contain character names or IDs; keep original logs and raw payloads local, redact them before sharing, and never add `var/`, packet captures, credentials, or raw collector logs to Git.

## Human live-test checklist

1. Confirm the listener prints `Collector listener ready`.
2. Start the collector with the exact private-only command above.
3. Open Albion Online on East/Asia and manually open a market.
4. Browse one item containing both BUY and SELL orders.
5. Wait for the listener to report one to three events.
6. Run the `lsof` check while the event is sent.
7. Stop the collector, then stop the listener.
8. Review `var/collector-events/` before sanitizing any fixture.

Do not commit the raw files. A sanitized `test/fixtures/collector-event*.json` may be added only after inspecting real events for identifiers or other sensitive fields.

## Live capture findings — 28 October 2026

The Mac M1/Rosetta collector sent 11 real market-order batches to the listener. The listener recorded receipt times and retained the first three batches: one 50-order BUY batch followed by two 50-order SELL batches. Collector logs explicitly reported successful sends to `http://127.0.0.1:8787`; 404 responses were for unsupported non-market topics such as festivities and market history, which are intentionally outside this PoC endpoint.

A second live scan produced ten more received batches. During that scan, repeated process-level `lsof` samples showed exactly two established collector sockets, both from local ephemeral ports to `127.0.0.1:8787`; no external or AODP/community socket appeared in those samples. Together with the verified `-i`/`-p` dispatcher behavior and collector logs naming the localhost destination, this is the available private-routing evidence for the PoC. The sampling limitation above still applies.

Two one-order fixtures were extracted from those batches and sanitized by removing order IDs and redundant group IDs:

- `test/fixtures/collector-event-buy.json`
- `test/fixtures/collector-event-sell.json`

The captured values establish:

- `AuctionType: "request"` is a BUY order and `AuctionType: "offer"` is a SELL order.
- `LocationId: "3008"` maps to Martlock in the upstream AODP location table.
- The game payload represents `UnitPriceSilver` at ×10,000 scale. The upstream AODP dedupe service normalizes it with integer division by `10000`; the captured examples therefore represent 372 and 7 silver respectively.
- `ItemTypeId`, `LocationId`, `QualityLevel`, `EnchantmentLevel`, `UnitPriceSilver`, `AuctionType`, `Amount`, and `Expires` are present.
- Server identity and observation time are absent. The listener receipt time is the observation time; `Expires` is only order expiry.

The raw batches remain under ignored `var/collector-events/` and must not be committed.

## Mapping to the future price schema

| Future field | Candidate source |
| --- | --- |
| `server` | validated local configuration (`East/Asia`) |
| `item_id` | `ItemTypeId` (preserve enchantment suffix) |
| `city` | confirmed location mapping (`3008` → Martlock in this capture) |
| `quality` | `QualityLevel` |
| `highest_buy_price` | maximum `request` `UnitPriceSilver / 10000` |
| `highest_buy_observed_at` | listener `receivedAt` |
| `lowest_sell_price` | minimum `offer` `UnitPriceSilver / 10000` |
| `lowest_sell_observed_at` | listener `receivedAt` |
| `last_ingested_at` | listener `receivedAt` |
| `source` | `local_collector` |

No Google Sheets access, production persistence, public deployment, or Task 08/09 behavior is included in this PoC.

## Task 07 verdict

- [x] Collector v0.1.61 runs on Mac M1 through installed Rosetta 2.
- [x] Manual gameplay produced real market events.
- [x] The listener received real BUY and SELL payloads on localhost.
- [x] Collector sockets during live scanning were restricted to `127.0.0.1:8787`; no community market upload was observed.
- [x] Payload fields, price scaling, location, and BUY/SELL semantics are documented.
- [x] Sanitized real-event fixtures are stored under `test/fixtures/`.
- [x] Local reproduction and troubleshooting steps are documented.
- [x] Tests, typecheck, and build pass.

Final verdict: **PASS**. Production ingestion, authentication, Google Sheets, and read APIs remain separate Tasks 08 and 09.
