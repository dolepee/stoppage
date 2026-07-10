import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildApprovedPublicClaim,
  loadLatestPrivateEvidence,
} from "../src/evidence/public-claim.js";

const approvedConfigHash = readStringArgument("--approved-config-hash");
const approvalStatement = readStringArgument("--approval");
const evidence = await loadLatestPrivateEvidence(
  "data/private",
  approvedConfigHash,
);
if (!evidence) {
  throw new Error(
    "No matching holdout and lifecycle candidate are ready for publication",
  );
}

const claim = buildApprovedPublicClaim({
  ...evidence,
  approvalStatement,
  approvedAt: new Date().toISOString(),
});
const publicRoot = resolve("data/public");
const output = resolve(publicRoot, "public-claim.json");
await mkdir(publicRoot, { recursive: true });
await writeFile(output, `${JSON.stringify(claim, null, 2)}\n`, { mode: 0o644 });
await chmod(output, 0o644);

console.log(
  JSON.stringify(
    {
      ok: true,
      status: claim.status,
      approvedConfigHash: claim.approvedConfigHash,
      evaluatedAt: claim.evaluatedAt,
      approvedAt: claim.approvedAt,
      output,
    },
    null,
    2,
  ),
);

function readStringArgument(name: string) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  if (name === "--approved-config-hash" && !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} requires a lowercase 32-byte hash`);
  }
  return value;
}
