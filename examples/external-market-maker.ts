import { StoppageAgentClient } from "../src/integration/stoppage-agent-client.js";

const baseUrl = process.env.STOPPAGE_URL ?? "http://localhost:4173";
const subjectHash = requiredHash("STOPPAGE_SUBJECT_HASH");
const quoteHash = requiredHash("STOPPAGE_QUOTE_HASH");
const client = new StoppageAgentClient({ baseUrl });
const request = {
  version: 1 as const,
  command: "PUBLISH_QUOTE" as const,
  subjectHash,
  market: "1X2" as const,
  quoteHash,
};

const result = await client.evaluate(request);
const permitValid = client.verifyPermitBinding(
  result.permit,
  request,
  Date.now(),
);

if (!result.permit || !permitValid) {
  console.log(`WITHHOLD ${result.decision}: ${result.reason}`);
  process.exitCode = 2;
} else {
  console.log(`PUBLISH AUTHORIZED: ${result.permit.hash}`);
}

function requiredHash(name: string): string {
  const value = process.env[name];
  if (!value || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase 32-byte 0x hash`);
  }
  return value;
}
