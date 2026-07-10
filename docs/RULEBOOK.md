# Deterministic rulebook

The defaults below are engineering values used to test the implementation.
They are not calibrated claims.

| Parameter                 | Default | Purpose                                          |
| ------------------------- | ------: | ------------------------------------------------ |
| Sharp move threshold      |  `0.04` | Maximum absolute 1X2 probability change          |
| Stability epsilon         | `0.006` | Maximum move between stable updates              |
| Stable updates            |     `3` | Consecutive updates required before repricing    |
| Reopen delay              |    `5s` | Confirmation window after repricing              |
| Event confirmation window |   `30s` | Associates an odds-first move with a later event |
| Recovery stability        |    `5s` | Both streams must remain healthy before recovery |

## Calibration discipline

1. Use an earlier chronological set to inspect event and odds ordering.
2. Freeze the metric definitions, thresholds, and rule rationales.
3. Record the configuration hash.
4. Evaluate only on later fixtures and live captures.
5. Publish every holdout lifecycle, including odds-led suspensions that never
   received supporting events and fail-safe activations.

The holdout command is deliberately approval-gated. It requires the exact
human-approved configuration hash and writes its report only under the ignored
private data directory:

```bash
pnpm policy:holdout -- --approved-config-hash <HASH> \
  --fixture <HOLDOUT_FIXTURE_1> --fixture <HOLDOUT_FIXTURE_2>
```

The fixture used in the video cannot be used to tune the thresholds.

## Trigger semantics

### Event before reprice

A high-impact event arrives while the latest accepted 1X2 quote predates the
event. Stoppage suspends immediately, including on an unconfirmed first signal,
then waits for stable consensus. The affected market cannot reopen until that
incident is confirmed or explicitly discarded.

### Odds before event

A probability component moves by at least the sharp-move threshold without a
recent high-impact event. Stoppage suspends conservatively. A later event may
confirm the move; otherwise the lifecycle remains labeled unconfirmed.

The reported unconfirmed odds-led suspension rate uses only these windows as its
denominator. It is `null` when a holdout contains no odds-led suspension. An
event-led window may begin from a provisional event and still complete normally
after that incident is confirmed or explicitly discarded.

### Fail-safe

If either required stream is unhealthy, the book enters `FAILSAFE`. Restoring
the stream does not reopen immediately: both streams must remain healthy, then
the normal stability and reopen rules must pass.
