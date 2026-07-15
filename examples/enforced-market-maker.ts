import { StoppageClient, type ExecutionIntent } from "@stoppage/sdk";

const client = new StoppageClient({
  baseUrl: process.env.STOPPAGE_URL ?? "http://localhost:4173",
});
const intent: ExecutionIntent = {
  version: 2,
  agentId: process.env.STOPPAGE_AGENT_ID ?? "external-market-maker",
  audience: process.env.STOPPAGE_AUDIENCE ?? "venue:external-market-maker",
  nonce: process.env.STOPPAGE_NONCE ?? crypto.randomUUID(),
  command: "PUBLISH_QUOTE",
  sequence: requiredInteger("STOPPAGE_SEQUENCE"),
  subjectHash: requiredHash("STOPPAGE_SUBJECT_HASH"),
  market: "1X2",
  quoteHash: requiredHash("STOPPAGE_QUOTE_HASH"),
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

function requiredHash(name: string): string {
  const value = process.env[name];
  if (!value || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase 32-byte 0x hash`);
  }
  return value;
}

function requiredInteger(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
