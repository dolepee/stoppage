# Architecture

## Runtime boundaries

1. **TxLINE client** renews guest JWTs, attaches the long-lived API token, reads
   fixtures/history, and maintains the odds and scores SSE streams.
2. **Normalizer** accepts only an unambiguous in-running `1X2` shape and maps
   relevant soccer actions into a small event vocabulary.
3. **Governor** executes deterministic state transitions and emits config-bound
   receipts.
4. **Reopen certifier** emits a sidecar proof only after feed health, incident
   resolution, quote stability, and release delay all pass. It binds those facts
   to the exact `REOPEN` receipt and policy hash.
5. **Evaluation runtime** maintains the always-open baseline separately from
   the governed book and computes non-financial risk metrics after a stable
   reference exists.
6. **Operator API** publishes synthetic judge snapshots and approved projections
   of derived lifecycle evidence. It never publishes TxLINE records, odds
   vectors, source identifiers, or credentials.
7. **Operator console** renders the same API used by the replay and live worker.

## State machine

```text
                     stream unhealthy
       ┌──────────────────────────────────────┐
       │                                      v
OPEN ──┴─ event / sharp move ─> SUSPENDED ─> FAILSAFE
 ^                                │              │
 │                                │ stable N     │ streams healthy
 │                                v              v
 └── certified release ────── REPRICED <── SUSPENDED
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

The reopen certificate is a separate canonical JSON object. It includes the
reopen receipt hash, configuration hash, and the exact values used by each
release gate. Keeping it separate preserves all previously approved receipt
hashes while making a safe release reproducible from the same normalized input
sequence.

## Hosted shape

The production service is one persistent Node process serving:

- the compiled React console;
- health, status, replay, and SSE APIs;
- the long-running TxLINE worker after activation.

The persistent host owns reconnect/backoff and health supervision. A local
`launchd` job may be used as an operational backup, not as the judged service.
