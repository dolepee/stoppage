import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildApprovedLiveDecisionTape,
  loadLatestLiveDecisionTapeCandidate,
} from "../src/evidence/live-decision-tape.js";

const approvalStatement = readOptionalStringArgument("--approval");
const candidate = await loadLatestLiveDecisionTapeCandidate();
if (!candidate) {
  throw new Error("No valid live decision-tape candidate is ready");
}

if (!approvalStatement) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        status: "AWAITING_HUMAN_APPROVAL",
        candidateHash: candidate.candidateHash,
        requiredApproval: candidate.requiredApproval,
        counters: candidate.payload.counters,
        publicTapeWritten: false,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const tape = buildApprovedLiveDecisionTape({
  candidate,
  approvalStatement,
  approvedAt: new Date().toISOString(),
});
const publicRoot = resolve("data/public");
const output = resolve(publicRoot, "live-decision-tape.json");
await mkdir(publicRoot, { recursive: true });
await writeFile(output, `${JSON.stringify(tape, null, 2)}\n`, { mode: 0o644 });
await chmod(output, 0o644);

console.log(
  JSON.stringify(
    {
      ok: true,
      status: tape.status,
      candidateHash: tape.candidateHash,
      approvedAt: tape.approvedAt,
      counters: tape.counters,
      output,
    },
    null,
    2,
  ),
);

function readOptionalStringArgument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
