# Stoppage

**An autonomous in-play quote governor driven by TxLINE on Solana.**

Stoppage freezes, reprices, and reopens a simulated operator book when the
match-event stream and the StablePrice market stream disagree. It is operator
risk tooling, not a wagering product: there is no custody, bet placement, or
claim of executable bookmaker fills.

## Product loop

```text
TxLINE scores ─┐
               ├─> deterministic policy ─> SUSPEND ─> REPRICE ─> REOPEN
TxLINE odds ───┘                └─────────> FAILSAFE on stream degradation
```

The MVP controls one market deeply: in-running soccer `1X2`. Every transition
emits a canonical JSON receipt bound to the policy configuration by SHA-256.
For the submission lifecycle, the triggering TxLINE event will also be checked
through TxODDS's official Solana mainnet validation path.

## Current status

- Deterministic quote governor: implemented and tested.
- Event-first, odds-first, and stream-failure paths: implemented and tested.
- Zero-friction public judge replay: implemented with a **synthetic normalized
  fixture**, visibly labeled in the application.
- TxLINE mainnet program and free service-level-12 row: independently read from
  Solana mainnet.
- Live TxLINE feed capture and real-fixture evaluation: gated on the dedicated
  mainnet subscription wallet and API activation. No live metrics are claimed
  before that gate passes.

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

The setup scripts deliberately separate wallet operations from the server:

```bash
pnpm wallet:create
pnpm txline:inspect
pnpm txline:activate
pnpm g1:probe
```

`txline:activate` refuses non-mainnet hosts, non-level-12 subscriptions, and
wallets without enough SOL for Token-2022 account rent and transaction fees.
Secrets are written only to ignored files with restrictive permissions.

## Policy

Stoppage is a deterministic state machine. No LLM participates in quote
decisions.

- `EVENT_BEFORE_REPRICE`: a confirmed goal, red card, penalty, or VAR signal
  arrives while the last quote predates it.
- `UNBACKED_MOVE`: a configured probability jump arrives without a supporting
  high-impact event inside the confirmation window.
- `STREAM_UNHEALTHY`: either required feed misses its health policy.
- `REPRICE`: the consensus vector remains inside the configured epsilon for the
  required number of consecutive updates.
- `REOPEN`: the post-reprice confirmation delay passes without renewed
  instability.

Thresholds shown in the repository are provisional engineering defaults. They
will be frozen after chronological calibration and approved before holdout
evaluation. Public metrics will come only from that holdout.

## Metrics

Stoppage does not report hypothetical betting profit or in-play CLV.

- `stale_quote_seconds`: time the baseline remains open while the governed book
  is unavailable.
- `mispricing_integral`: probability divergence multiplied by time, evaluated
  against the first post-trigger quote satisfying the frozen stability rule.
- suspension and reopen latency.
- unconfirmed-suspension rate.
- fixed-horizon repricing error.
- stream uptime and failover count.

The stable reference is used only after the lifecycle for evaluation. It is
never available to the live decision path.

## Data boundary

Raw TxLINE payloads and credentials are private runtime material. They are not
committed or returned by the public API. The application exposes normalized
state transitions, aggregate metrics, source identifiers, and hashes. Private
captures are purged when the hackathon data licence terminates.

See [architecture](docs/ARCHITECTURE.md), [rulebook](docs/RULEBOOK.md),
[mainnet setup](docs/MAINNET_SETUP.md), and [data policy](docs/DATA_POLICY.md).

## Verification

```bash
pnpm check
```

This runs formatting checks, TypeScript checks, domain and integration tests,
and a production build.

## License

MIT. The vendored TxODDS IDL remains subject to its upstream ISC licence; see
[third-party notices](THIRD_PARTY_NOTICES.md).
