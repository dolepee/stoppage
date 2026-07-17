# @stoppage/sdk

Fail-closed TypeScript enforcement for Stoppage Permit V2.

## Install the release artifact

The SDK is packaged as a GitHub Release artifact rather than published to the
npm registry in this submission release:

```bash
npm install https://github.com/dolepee/stoppage/releases/download/sdk-v0.2.3/stoppage-sdk-0.2.3.tgz
```

## Runnable public quickstart

```ts
import { StoppageClient, type ExecutionIntent } from "@stoppage/sdk";

const stoppage = new StoppageClient({
  baseUrl: "https://stoppage-txline.vercel.app",
});
const context = await stoppage.discoverContext();
const intent: ExecutionIntent = {
  version: 2,
  agentId: "external-market-maker",
  audience: "venue:external-market-maker",
  nonce: crypto.randomUUID(),
  command: "PUBLISH_QUOTE",
  sequence: context.sequence,
  subjectHash: context.subjectHash,
  market: context.market,
  quoteHash: context.quoteHash,
};

const outcome = await stoppage.guardAction(intent, async () => {
  // Replace only this callback with the external agent's venue adapter.
  return { simulatedVenueReceipt: crypto.randomUUID() };
});

if (outcome.status === "VENUE_CALL_WITHHELD") {
  console.log("WITHHELD", outcome.verification.decision);
} else {
  console.log("EXECUTED", outcome.value.simulatedVenueReceipt);
}
```

`discoverContext()` returns the complete, visibly synthetic public Judge Lab
checkpoint, so this example needs no private feed, fixture ID, or opaque hash
environment variables. A production consumer derives the same sequence,
subject hash, and quote hash from its own authorized feed before calling
`guardAction()`; Stoppage never receives venue credentials.

`guardAction()` invokes its callback only after an Ed25519 Permit V2 verifies
against a discovered Stoppage public key, the exact action bindings match, the
permit is live, and the request nonce has not already been consumed. Nonce
protection is shared across `StoppageClient` instances created from one loaded
SDK module. It remains in-memory, non-durable, and non-distributed. Entries
retain only the permit expiry and are pruned after the five-second permit
lifetime using the runtime wall clock. A caller-supplied timestamp used for
offline verification cannot evict a live nonce claim.

The exported `runBenchLite()` helper mutates a signed permit six ways and sends
every candidate through this package's offline verifier. The browser Judge Lab
uses that helper directly; it does not trust server-returned attack grades.
