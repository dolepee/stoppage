# Architecture

## Runtime boundaries

1. **TxLINE client** renews guest JWTs, attaches the long-lived API token, reads
   fixtures/history, and maintains the odds and scores SSE streams.
2. **Normalizer** accepts only an unambiguous in-running `1X2` shape and maps
   relevant soccer actions into a small event vocabulary.
3. **Resolution-aware governor** executes deterministic state transitions,
   invalidates a candidate price branch when a provisional incident resolves,
   and emits config-bound receipts.
4. **Reopen certifier** emits a sidecar proof only after feed health, incident
   resolution, fresh post-resolution quote stability, and release delay all
   pass. It binds those facts to the exact `REOPEN` receipt and policy hash.
5. **Evaluation runtime** maintains the always-open baseline separately from
   the governed book and computes non-financial risk metrics after a stable
   reference exists.
6. **Execution Gate** projects the exact current governor state into `BLOCK` or
   a short-lived `ALLOW` permit. It binds the subject, quote, policy, latest
   state receipt, Certified Reopen proof where required, sequence, and expiry.
   It contains no independent decision policy.
7. **Reference market-maker** verifies the permit immediately before every
   simulated `PUBLISH_QUOTE` action. It cannot publish in `SUSPENDED`,
   `REPRICED`, or `FAILSAFE`.
8. **Live Decision Tape** converts a real or privately replayed TxLINE quote
   into a Permit V2 request. The intended reference agent verifies it offline
   before its simulated callback; a second audience attempts the same permit
   and must remain closed. The result proves permit non-transferability, not
   authenticated caller identity. Optional tape persistence and diagnostics run
   behind an isolated queue and cannot reject the core feed callback.
9. **Approval boundary** aggregates private tape records, re-verifies the signed
   sample, enforces both zero-callback invariants, strips licensed fields, and
   requires an exact human approval before writing public evidence.
10. **Operator API** publishes synthetic judge snapshots and approved
    projections of derived lifecycle and enforcement evidence. It never
    publishes TxLINE records, odds vectors, source identifiers, or credentials.
11. **Operator console** renders the same gate evaluator used by the API and
    reference client.

## State machine

```text
                     stream unhealthy
       ┌──────────────────────────────────────┐
       │                                      v
OPEN ──┴─ event / sharp move ─> SUSPENDED ─> FAILSAFE
 ^                                │              │
 │                                │ fresh stable N│ streams healthy
 │                                v              v
 └── certified release ────── REPRICED <── SUSPENDED
                                  │
                  confirm/discard │ invalidate stale branch
                                  └──────────────> SUSPENDED
```

`REPRICED` is a visible lifecycle state: the replacement quote has been chosen,
but it is not exposed until every release gate passes and a Certified Reopen
proof is emitted.

## Determinism

The configuration is canonicalized and hashed. A private receipt contains the
action, trigger, state transition, source identifiers, observed timestamp,
optional quote vector, and configuration hash. Equivalent inputs and
configuration produce byte-identical receipt hashes. Public evidence projects
only approved derived fields and the receipt hash.

The revision-2 reopen certificate is a separate canonical JSON object. It
includes the reopen receipt hash, configuration hash, resolution outcome,
resolution time, first post-resolution quote time, quote count, and the exact
values used by the remaining release gates. Revision 1 remains available for
reproducing the approved holdout; revision 2 has a distinct config hash.

The Execution Gate permit is another additive canonical object. A permit is not
a new source of truth: it is valid only while its quote hash, governor sequence,
latest state receipt, policy hash, stream health, and expiry still match the
current context. For post-incident release it must also reference the exact
verified Certified Reopen proof.

## Solana boundary

Solana is the TxLINE access and validation layer. Stoppage's mainnet Token-2022
subscription authorizes the feed, and TxODDS's `validateStat` instruction checks
finalized score states against the sponsor's on-chain root. The latency-sensitive
execution gate remains off-chain because the available stat proof does not
establish event timing, VAR resolution timing, or odds freshness. No generic
Stoppage account write is represented as proof of those facts.

## Hosted shape

The production service is one persistent Node process serving:

- the compiled React console;
- health, status, replay, and SSE APIs;
- the long-running TxLINE worker after activation.

The persistent host owns reconnect/backoff and health supervision. A local
`launchd` job may be used as an operational backup, not as the judged service.
The TxLINE token is injected only through the host's secret environment. Raw
captures use a private persistent volume, join the licence-end purge list, and
never pass through the sanitized health endpoint.

`render.yaml` is the production blueprint. `src/hosted.ts` owns the Fastify
process and a supervised worker child, restarting that child after an unexpected
exit. Render's health check targets `/api/host-health`, which returns success
only while the persisted worker heartbeat is fresh and both required streams
are healthy. The service disk is mounted at `/var/data`; private captures and
runtime state use separate directories under that mount.

The worker and API do not maintain two policy engines. After each serialized
TxLINE input, the worker persists the existing governor state and reopen proofs
to a mode-0600 runtime context keyed by a hashed subject. The API reads that
private object only when evaluating `POST /api/execution-gate/evaluate`; it
returns the `BLOCK` result or canonical permit without returning fixture IDs,
quotes, source IDs, or proofs. Context age is capped at five seconds, so a dead
worker cannot authorize from a cached healthy state.

Permit V1 requests retain their existing response contract. A strict Permit V2
request additionally supplies agent ID, audience, nonce, and expected sequence.
The live route signs only after that sequence matches the fresh private context.
Key discovery is origin-specific, so a consumer must fetch keys from the same
origin that issued its permit.

The public Vercel deployment serves only the human-approved frozen Live Decision
Tape aggregate. It labels private-capture replay separately and does not present
that aggregate as persistent hosted-worker uptime. Replay Permit V2 timestamps
come from the replay execution clock rather than the private capture, and a
publishable aggregate must contain a signed Certified Reopen sample.
