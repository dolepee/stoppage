import { StoppageRuntime } from "../src/runtime/stoppage-runtime.js";
import { publicJudgeScenario } from "../src/replay/public-scenario.js";

const runtime = new StoppageRuntime(publicJudgeScenario);
await runtime.start(16);
const snapshot = runtime.snapshot();
const agentEvents = snapshot.timeline.filter((item) => item.kind === "AGENT");

if (!agentEvents.some((item) => item.label === "QUOTE_BLOCKED")) {
  throw new Error("Execution Gate verification did not observe QUOTE_BLOCKED");
}
if (
  !agentEvents.some((item) => item.label === "SIMULATED_QUOTE_PUBLISHED") ||
  snapshot.execution.agent.decisionCode !== "ALLOW_CERTIFIED_REOPEN" ||
  !snapshot.execution.agent.permitVerified ||
  !snapshot.execution.agent.permit
) {
  throw new Error(
    "Execution Gate verification did not finish with a verified Certified Reopen permit",
  );
}

console.log(
  JSON.stringify(
    {
      status: "OK",
      scenario: snapshot.scenarioId,
      agentEvents: agentEvents.map((item) => ({
        action: item.label,
        decision: item.detail,
      })),
      permitHash: snapshot.execution.agent.permit.hash,
      reopenProofHash: snapshot.execution.agent.permit.body.reopenProofHash,
      simulated: snapshot.execution.agent.simulated,
    },
    null,
    2,
  ),
);
