import { QuoteGovernor } from "../src/domain/governor.js";
import { verifyReopenProof } from "../src/domain/reopen-proof.js";
import { publicJudgeScenario } from "../src/replay/public-scenario.js";

const governor = new QuoteGovernor();
for (const step of publicJudgeScenario.steps) governor.process(step.input);

const fixtureId = publicJudgeScenario.match.fixtureId;
const receipts = governor.getState(fixtureId).receipts;
const proofs = governor.getReopenProofs(fixtureId);
if (proofs.length === 0)
  throw new Error("No Certified Reopen proof was emitted");

const results = proofs.map((proof) => {
  const receipt = receipts.find(
    (candidate) => candidate.hash === proof.body.reopenReceiptHash,
  );
  if (!receipt || !verifyReopenProof(proof, receipt)) {
    throw new Error(`Invalid Certified Reopen proof ${proof.hash}`);
  }
  return {
    proofHash: proof.hash,
    receiptHash: receipt.hash,
    configHash: proof.body.configHash,
    checks: proof.body.checks,
  };
});

console.log(
  JSON.stringify(
    {
      ok: true,
      scenario: publicJudgeScenario.id,
      certifiedReopens: results.length,
      results,
    },
    null,
    2,
  ),
);
