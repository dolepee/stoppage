# Architecture

## Runtime boundaries

1. **TxLINE client** renews guest JWTs, attaches the long-lived API token, reads
   fixtures/history, and maintains the odds and scores SSE streams.
2. **Normalizer** accepts only an unambiguous in-running `1X2` shape and maps
   relevant soccer actions into a small event vocabulary.
3. **Governor** executes deterministic state transitions and emits config-bound
   receipts.
4. **Evaluation runtime** maintains the always-open baseline separately from
   the governed book and computes non-financial risk metrics after a stable
   reference exists.
5. **Operator API** publishes normalized snapshots and decision receipts. It
   never publishes TxLINE raw payloads or credentials.
6. **Operator console** renders the same API used by the replay and live worker.

## State machine

```text
                     stream unhealthy
       ┌──────────────────────────────────────┐
       │                                      v
OPEN ──┴─ event / sharp move ─> SUSPENDED ─> FAILSAFE
 ^                                │              │
 │                                │ stable N     │ streams healthy
 │                                v              v
 └──── confirmation delay ─── REPRICED <── SUSPENDED
```

`REPRICED` is a visible lifecycle state: the replacement quote has been chosen,
but it is not exposed until the confirmation delay passes.

## Determinism

The configuration is canonicalized and hashed. A receipt contains the action,
trigger, state transition, source identifiers, observed timestamp, optional
quote vector, and configuration hash. Equivalent inputs and configuration
produce byte-identical receipt hashes.

## Hosted shape

The production service is one persistent Node process serving:

- the compiled React console;
- health, status, replay, and SSE APIs;
- the long-running TxLINE worker after activation.

The persistent host owns reconnect/backoff and health supervision. A local
`launchd` job may be used as an operational backup, not as the judged service.
