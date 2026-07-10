# TxLINE data policy

TxODDS data is licensed for hackathon participation and is not redistributed.

## Private

- Raw fixtures, odds, and score payloads.
- API and guest tokens.
- Wallet key material.
- Replay captures used for calibration and holdout evaluation.

Private captures live under ignored runtime directories and are purged when the
hackathon data licence terminates.

## Public

- State transitions and policy actions.
- Aggregate, non-financial evaluation metrics.
- Cryptographic commitments to private inputs, without the source records or
  identifiers.
- Decision receipt hashes and approved proof transactions.
- A normalized synthetic scenario for zero-friction judge testing.

The public API does not expose an endpoint that returns captured TxLINE payloads.
Real-match quote vectors and score records are not embedded in the deployed app
or demo media.
