import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildLiveDecisionTapeCandidate } from "../src/evidence/live-decision-tape.js";
import {
  loadPermitSigner,
  loadRetiredPermitVerificationKeys,
  publicKeySetFor,
} from "../src/execution-gate/permit-v2.js";
import type { LiveDecisionTapeRecord } from "../src/live/live-decision-tape.js";
import { writePrivateCapture } from "../src/private/capture-store.js";

const privateRoot = resolve(
  process.env.STOPPAGE_PRIVATE_ROOT ?? "data/private",
);
const records = await readJsonLines(
  resolve(privateRoot, "live-decision-tape.jsonl"),
);
const signer = loadPermitSigner({ ...process.env, NODE_ENV: "production" });
const retiredKeys = loadRetiredPermitVerificationKeys(process.env);
const candidate = buildLiveDecisionTapeCandidate(
  records,
  publicKeySetFor(signer, retiredKeys),
);
const path = await writePrivateCapture(
  `live-decision-tape-candidate-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.json`,
  candidate,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      status: "AWAITING_HUMAN_APPROVAL",
      candidateHash: candidate.candidateHash,
      requiredApproval: candidate.requiredApproval,
      counters: candidate.payload.counters,
      signer: candidate.payload.signer,
      privateCandidate: path,
      publicTapeWritten: false,
    },
    null,
    2,
  ),
);

async function readJsonLines(path: string): Promise<LiveDecisionTapeRecord[]> {
  const content = await readFile(path, "utf8");
  const records: LiveDecisionTapeRecord[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as LiveDecisionTapeRecord);
    } catch {
      throw new Error(`Malformed live tape JSON at line ${index + 1}`);
    }
  }
  if (records.length === 0) {
    throw new Error("No private live decision-tape records are available");
  }
  return records;
}
