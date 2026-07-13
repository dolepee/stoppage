import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { DecisionReceipt } from "../src/domain/types.js";
import { projectDecisionReceipt } from "../src/evidence/public-projection.js";
import { writePrivateCapture } from "../src/private/capture-store.js";

const fixtureId = readIntegerArgument("--fixture");
const validationTransaction = readStringArgument("--validation-tx");
const suspendReceiptHash = readHashArgument("--suspend-receipt-hash");
const replayPath = await findLatestReplay(fixtureId);
const replay = JSON.parse(await readFile(replayPath, "utf8")) as {
  configHash: string;
  lifecycles: Array<{
    suspendTs: number;
    reopenTs: number;
    maximumProbabilityMove: number | null;
    suspendHash: string;
    repriceHash: string;
    reopenHash: string;
    decisionHashes: string[];
    preResolutionRepricesInvalidated: number;
  }>;
  receipts: DecisionReceipt[];
};
const selected = replay.lifecycles.find(
  (lifecycle) => lifecycle.suspendHash === suspendReceiptHash,
);
if (!selected || selected.preResolutionRepricesInvalidated < 1) {
  throw new Error(
    "Selected receipt does not anchor a complete resolution-aware lifecycle",
  );
}
if (selected.maximumProbabilityMove === null) {
  throw new Error("Resolution-aware lifecycle lacks a probability move");
}

const receiptByHash = new Map(
  replay.receipts.map((receipt) => [receipt.hash, receipt]),
);
const decisions = selected.decisionHashes.map((hash) => {
  const receipt = receiptByHash.get(hash);
  if (!receipt) throw new Error(`Replay receipt ${hash} is missing`);
  return projectDecisionReceipt(receipt, selected.suspendTs);
});

const candidate = {
  version: 2,
  status: "AWAITING_HUMAN_APPROVAL",
  evidenceType: "DERIVED_LIFECYCLE_EVIDENCE",
  network: "solana-mainnet",
  policyRevision: 2,
  dataBoundary:
    "No TxLINE records, vectors, identifiers, or absolute source timestamps.",
  lifecycleDurationMs: selected.reopenTs - selected.suspendTs,
  maximumProbabilityMove: selected.maximumProbabilityMove,
  preResolutionRepricesInvalidated: selected.preResolutionRepricesInvalidated,
  configHash: replay.configHash,
  decisions,
  txlineValidation: {
    transactionSignature: validationTransaction,
    explorer: `https://solscan.io/tx/${validationTransaction}`,
  },
};
assertPublicBoundary(candidate);
const path = await writePrivateCapture(
  `public-evidence-candidate-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  candidate,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      status: candidate.status,
      lifecycleDurationMs: candidate.lifecycleDurationMs,
      maximumProbabilityMove: candidate.maximumProbabilityMove,
      decisions: candidate.decisions,
      txlineValidation: candidate.txlineValidation,
      privateCandidate: path,
      approvalRequired: true,
    },
    null,
    2,
  ),
);

function assertPublicBoundary(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    '"fixtureId"',
    '"sourceIds"',
    '"quote"',
    '"observedTs"',
    '"eventId"',
  ]) {
    if (serialized.includes(forbidden)) {
      throw new Error(`Public evidence contains forbidden field ${forbidden}`);
    }
  }
}

async function findLatestReplay(id: number) {
  const root = resolve("data/private");
  const latest = (await readdir(root))
    .filter(
      (name) => name.startsWith(`replay-${id}-`) && name.endsWith(".json"),
    )
    .sort()
    .at(-1);
  if (!latest) throw new Error(`No replay found for fixture ${id}`);
  return resolve(root, latest);
}

function readIntegerArgument(name: string): number {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : Number.NaN;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} requires a positive integer`);
  }
  return value;
}

function readStringArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value)) {
    throw new Error(`${name} requires a Solana transaction signature`);
  }
  return value;
}

function readHashArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} requires a lowercase 32-byte hash`);
  }
  return value;
}
