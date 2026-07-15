# @stoppage/sdk

Fail-closed TypeScript enforcement for Stoppage Permit V2.

```ts
import { StoppageClient } from "@stoppage/sdk";

const stoppage = new StoppageClient({
  baseUrl: "https://stoppage-txline.vercel.app",
});

const outcome = await stoppage.guardAction(intent, async () => {
  return simulatedVenue.publishQuote();
});

if (outcome.status === "VENUE_CALL_WITHHELD") {
  console.log(outcome.verification.decision);
}
```

`guardAction()` invokes its callback only after an Ed25519 Permit V2 verifies
against a discovered Stoppage public key, the exact action bindings match, the
permit is live, and the request nonce has not already been consumed. Nonce
protection is in-memory and therefore process-local in this release artifact.
