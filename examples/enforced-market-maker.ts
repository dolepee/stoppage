import { StoppageClient, type ExecutionIntent } from "@stoppage/sdk";

const client = new StoppageClient({
  baseUrl: process.env.STOPPAGE_URL ?? "https://stoppage-txline.vercel.app",
});
const context = await client.discoverContext();
const intent: ExecutionIntent = {
  version: 2,
  agentId: process.env.STOPPAGE_AGENT_ID ?? "external-market-maker",
  audience: process.env.STOPPAGE_AUDIENCE ?? "venue:external-market-maker",
  nonce: process.env.STOPPAGE_NONCE ?? crypto.randomUUID(),
  command: "PUBLISH_QUOTE",
  sequence: context.sequence,
  subjectHash: context.subjectHash,
  market: context.market,
  quoteHash: context.quoteHash,
};

const outcome = await client.guardAction(intent, async () => {
  // Replace this function with the agent's venue adapter. Stoppage never owns
  // venue credentials or funds and cannot invoke this callback before verify.
  return { simulatedVenueReceipt: crypto.randomUUID() };
});

if (outcome.status === "VENUE_CALL_WITHHELD") {
  console.log(`WITHHELD ${outcome.verification.decision}`);
  process.exitCode = 2;
} else {
  console.log(`EXECUTED ${outcome.value.simulatedVenueReceipt}`);
}
