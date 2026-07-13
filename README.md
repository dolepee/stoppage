# Stoppage

![Stoppage operator console social card](app/public/og-stoppage.png)

**The VAR firewall for in-play markets.**

Live judge console: <https://stoppage-txline.vercel.app>

Stoppage is an autonomous execution firewall driven by TxLINE on Solana. A
reference market-maker agent must ask Stoppage before publishing a simulated
quote. When a provisional goal or VAR incident moves the market, Stoppage
returns `BLOCK`, invalidates any branch formed before the incident resolves,
and issues a short-lived, machine-verifiable `ALLOW` permit only after fresh
post-resolution consensus. It is operator risk tooling, not a wagering product:
there is no custody, bet placement, or claim of executable bookmaker fills.

The failure is operationally real. Sportradar's
[`bet_stop` documentation](https://docs.sportradar.com/uof/data-and-features/messages/event/bet-stop)
keeps active markets suspended until a later active status, while
[Betfair's football rules](https://support.betfair.com/app/answers/detail/a_id/10642/)
allow bets between a material event and its VAR cancellation to be voided.
Stoppage controls the narrower downstream question: whether an autonomous agent
may act on the current price branch.

## Product loop

```text
TxLINE provisional event ─> HOLD ─> candidate reprice
                                      │
TxLINE confirm / discard ─────────────┴─> INVALIDATE PRE-RESOLUTION BRANCH
TxLINE fresh odds ─> stable 3/3 ─> REPRICE ─> CERTIFIED REOPEN
                                                  │
agent PUBLISH_QUOTE ─> BLOCK during hold ──────────┴─> verified ALLOW permit
```

The MVP controls one market deeply: in-running soccer `1X2`. Every transition
emits a canonical JSON receipt bound to the policy configuration by SHA-256.
Every `REOPEN` also emits a sidecar proof binding the exact decision receipt to
the feed-health, incident-resolution, post-resolution quote-freshness,
quote-stability, and safety-delay checks that authorized release. The
sponsor-specific proof path is live: a confirmed score stat was checked through
TxODDS's official Solana mainnet `validateStat` instruction.

## Certified Reopen

Suspending a market is standard feed behavior. The harder failure is reopening
on a quote that belongs to the provisional branch after VAR confirms or
overturns the incident. Stoppage revision 2 makes that stale-branch reopen
impossible and inspectable.

A `CERTIFIED_REOPEN` proof is emitted only when:

- both required TxLINE streams are healthy;
- no provisional incident remains unresolved;
- any pre-resolution reprice has been invalidated;
- the replacement quote sequence was observed after the latest resolution;
- the consensus quote has met the frozen stability count;
- the configured post-reprice delay has elapsed; and
- a replacement quote is present.

The V2 certificate records the resolution branch (`CONFIRMED` or `DISCARDED`),
resolution timestamp, first fresh quote timestamp, and post-resolution quote
count. It binds those checks to the exact `REOPEN` receipt and policy hash. Run
the public synthetic VAR-overturn lifecycle and verify every certificate with:

```bash
pnpm reopen:verify
```

## Execution Gate

The Execution Gate is a pure projection of the existing governor state, not a
second policy engine. A downstream client submits `PUBLISH_QUOTE` with a
privacy-safe subject hash and exact quote hash. The gate returns a block reason
or a canonical permit binding the quote, policy, latest state receipt, current
Certified Reopen proof where required, execution sequence, issue time, and
expiry.

The reference agent verifies the permit immediately before its simulated
publish. A new quote, event, resolution, receipt, stream failure, sequence,
policy, or expiry revokes the previous permit. The approved permit TTL is five
seconds, approximately five measured median quote intervals; quote and sequence
changes still revoke immediately. This exact parameter shipped in the
human-approved release manifest.

```bash
pnpm gate:verify
```

The same evaluator is available from `POST /api/execution-gate/evaluate` on the
persistent application runtime. The live worker writes a private per-fixture
context after every processed input; the API resolves it by subject hash and
returns only the gate result. A context older than five seconds fails closed,
and fixture IDs, quote vectors, source IDs, and feed records never enter the
response. A downstream agent that already consumes TxLINE computes the subject
and quote hashes with the exported helpers before requesting authorization. The
public static console runs the evaluator locally over the synthetic fixture so
judges need no token or login.

## Current status

- Resolution-aware quote governor: implemented and adversarially tested.
- Provisional reprice invalidation and post-resolution freshness gate:
  implemented in policy revision 2.
- Event-first, odds-first, and stream-failure paths: implemented and tested.
- Execution Gate and deterministic reference agent: implemented with canonical
  permit verification, expiry, sequence revocation, and adversarial tamper tests.
- Live gate bridge: the persistent worker projects private governor state into a
  shared runtime context, and the application API fails closed if that context
  is missing, invalid, or more than five seconds old.
- Certified Reopen proofs: implemented, receipt-bound, policy-bound, and
  independently reproducible from the normalized replay.
- Zero-friction public judge replay: implemented with a **synthetic normalized
  fixture**, visibly labeled in the application.
- TxLINE service-level-12 subscription and API activation: confirmed on Solana
  mainnet.
- Dual-stream transport gate: mainnet fixtures, odds, and scores were observed
  together through the full private runtime gate. Raw transport records remain
  private under the event data licence.
- Private historical gate: four captured fixtures each produced at least one
  complete `SUSPEND -> REPRICE -> REOPEN` lifecycle. Raw TxLINE records and
  real-match vectors remain private under the event data licence.
- TxLINE on-chain score validation: confirmed on Solana mainnet with a true
  predicate result.
- Public real-match metrics: four held-out fixtures, 18 complete protected
  windows, 11 pre-resolution reprices invalidated, and 18 fresh
  post-resolution Certified Reopens (14 confirmed, 4 discarded), human-approved
  under revision 2 in `/api/public-claim`. The endpoint exposes only derived
  aggregates, lifecycle decisions, hashes, and public Solana evidence; raw
  fixture IDs, records, source timestamps, and vectors remain private.
- Trigger coverage is explicit: all 18 real holdout windows were event-led. The
  odds-led `UNBACKED_MOVE` detector is implemented and tested but was not
  exercised by the real holdout, so no odds-led success rate is claimed.

## Mainnet evidence

| Proof                         | Public evidence                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| TxLINE program                | [`9Exb...cKaA`](https://solscan.io/account/9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA)                                         |
| Free-tier subscription        | [`27b1...KP3T`](https://solscan.io/tx/27b1KoYCrWD9MkZY86rkUpJmWzqyRjHmi5hC8CNMwA81jr8QBVmR7diYy6tWE3LLfXA3KfLCzZsStGkG7YZWKP3T)  |
| TxLINE `validateStat` success | [`61Uy...XDs8E`](https://solscan.io/tx/61UyrsHoqMeAAjJHPvnoo4L6F91oiFH4aFe2WQg6LHuLA5sZvQ7wdEoFPndhnPjaWHzkB1bfzZ3r8PSeRJQXDs8E) |

The validation transaction is the sponsor-specific proof. Stoppage decision
hashes remain supporting evidence rather than the product's main action.

## Why Solana

The TxLINE data licence and validation layer live on Solana: access is activated
through a mainnet Token-2022 subscription, and finalized score states are
checked through TxODDS's own on-chain Merkle-validation instruction. The
real-time execution control plane stays off-chain because quote gating is
latency-sensitive and the available on-chain stat proof does not prove VAR
timing or odds freshness. Stoppage does not disguise a generic account write as
on-chain enforcement.

## Run locally

Prerequisites: Node.js 22+ and pnpm 10+.

```bash
pnpm install
pnpm check
pnpm start
```

Open `http://localhost:4173`. The replay requires no wallet, token, or login.

For development:

```bash
pnpm dev
```

## Mainnet integration

Stoppage uses the TxLINE mainnet deployment:

| Item                | Value                                            |
| ------------------- | ------------------------------------------------ |
| Network             | Solana mainnet                                   |
| TxLINE program      | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`   |
| Free real-time tier | Service level `12`                               |
| API origin          | `https://txline.txodds.com`                      |
| Odds stream         | `/api/odds/stream`                               |
| Scores stream       | `/api/scores/stream`                             |
| Historical scores   | `/api/scores/historical/{fixtureId}`             |
| Historical odds     | `/api/odds/updates/{epochDay}/{hour}/{interval}` |
| Score proof         | `/api/scores/stat-validation`                    |
| Public claim        | `/api/public-claim`                              |
| Execution Gate      | `/api/execution-gate/evaluate`                   |

The setup scripts deliberately separate wallet operations from the server:

```bash
pnpm wallet:create
pnpm txline:inspect
pnpm txline:activate
pnpm g1:probe
pnpm worker:live
```

`txline:activate` refuses non-mainnet hosts, non-level-12 subscriptions, and
wallets without enough SOL for Token-2022 account rent and transaction fees.
Secrets are written only to ignored files with restrictive permissions.

`worker:live` supervises both SSE streams, records raw payloads only under the
ignored private capture directory, reconnects with bounded backoff, emits
stream-health inputs into the same governor, and persists derived decision
receipts and Certified Reopen sidecars separately. It also refreshes the fixture
catalog every five minutes so new knockout fixtures become eligible without a
restart.

For a container host, the compiled worker runs without development dependencies:

```bash
docker compose --profile live up -d --build
curl http://localhost:4173/api/worker-health
```

The live profile keeps raw captures and runtime state in separate persistent
volumes. The health endpoint exposes only derived counters, stream state, and
message age; it never returns credentials, source identifiers, or feed records.

The repository also includes a `render.yaml` blueprint for one persistent web
service. It starts the public console and supervised live worker in the same
process group, stores private captures and health state on an encrypted service
disk, injects `TXLINE_API_TOKEN` only through the host secret environment, and
fails `/api/host-health` with HTTP 503 when the worker state is stale or either
required feed is unhealthy. The console displays live-worker status only when
the same application runtime can read real state; the static judge build does
not substitute demo uptime. No persistent cloud-worker URL or cloud-uptime
claim is made; the blueprint is deployability evidence only.

## Policy

Stoppage is a deterministic state machine. No LLM participates in quote
decisions.

- `EVENT_BEFORE_REPRICE`: a goal, red card, penalty, or VAR signal arrives while
  the last quote predates it. An unconfirmed signal suspends immediately, but
  confirmation or explicit discard is required before reopening.
- `UNBACKED_MOVE`: a configured probability jump arrives without a supporting
  high-impact event inside the confirmation window. This path is implemented
  and adversarially tested, but all 18 real holdout windows were event-led; the
  odds-led path is not presented as real-data proof.
- `STREAM_UNHEALTHY`: either required feed misses its health policy.
- `REPRICE`: the consensus vector remains inside the configured epsilon for the
  required number of consecutive updates.
- `INVALIDATE_REPRICE`: confirmation or discard resolves a provisional incident
  after a candidate reprice. That branch is rejected, its stability count is
  cleared, and late quotes whose source or receipt time predates the resolution
  cannot count toward release.
- `REOPEN`: all pending incidents are confirmed or discarded and the
  full post-resolution stability sequence plus post-reprice delay pass without
  renewed instability. The release emits a proof binding every satisfied gate
  to that exact decision receipt.

Revision 1 is exported unchanged as `APPROVED_GOVERNOR_CONFIG_V1` so its earlier
receipts remain reproducible. Revision 2 keeps the measured numeric thresholds
and adds `postResolutionFreshQuotesRequired: true`. Its human-approved policy
hash is
`0x1d773f...fcf2` (published in full by `/api/public-claim`);
the separately approved public claim binds that exact hash and candidate digest.

## Metrics

Stoppage does not report hypothetical betting profit or in-play CLV.

- `stale_quote_seconds`: time the baseline remains open while the governed book
  is unavailable.
- `mispricing_integral`: probability divergence multiplied by time, evaluated
  against the first post-trigger quote satisfying the frozen stability rule.
- pre-resolution candidate reprices invalidated at confirmation or discard.
- post-resolution Certified Reopens, split by confirmed and discarded outcomes.
- suspension and reopen latency.
- unconfirmed odds-led suspension rate: odds-led windows that remained
  `UNBACKED_MOVE` through repricing divided by all odds-led windows; `null` means
  no odds-led case was observed, not that event-led windows failed to complete.
- fixed-horizon repricing error.
- stream uptime and failover count.

The stable reference is used only after the lifecycle for evaluation. It is
never available to the live decision path.

## Data boundary

Raw TxLINE payloads, odds vectors, score records, identifiers, and credentials
are private runtime material. They are not committed or returned by the public
API. The public application exposes synthetic judge inputs plus Stoppage-derived
state transitions, approved aggregate metrics, hashes, and public Solana proof
transactions from `/api/public-claim`. Private captures are purged when the
hackathon data licence terminates.

The approved hashes establish that the evaluated candidate was not silently
changed after human approval; they do not make licensed raw records publicly
reproducible. Judges may request a live screen-share reproduction of the private
holdout without redistribution of the underlying data.

See [architecture](docs/ARCHITECTURE.md), [rulebook](docs/RULEBOOK.md),
[mainnet setup](docs/MAINNET_SETUP.md), and [data policy](docs/DATA_POLICY.md).

## Verification

```bash
pnpm check
pnpm gate:verify
pnpm reopen:verify
```

`pnpm check` runs formatting checks, TypeScript checks, domain and integration
tests, and a production build. `pnpm gate:verify` runs the reference agent from
blocked execution to a verified Certified Reopen permit. `pnpm reopen:verify`
independently reruns the public normalized lifecycle and rejects a modified
proof, receipt, or policy binding.

## License

MIT. The vendored TxODDS IDL remains subject to its upstream ISC licence; see
[third-party notices](THIRD_PARTY_NOTICES.md).
