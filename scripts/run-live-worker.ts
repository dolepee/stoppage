import { QuoteGovernor } from "../src/domain/governor.js";
import { loadConfig } from "../src/config.js";
import { TxLineLiveWorker } from "../src/live/txline-live-worker.js";
import { appendPrivateCapture } from "../src/private/capture-store.js";
import { writeRuntimeState } from "../src/private/runtime-store.js";
import { TxLineClient } from "../src/txline/client.js";

const config = loadConfig();
if (!config.txlineApiToken) {
  throw new Error(
    "TXLINE_API_TOKEN is required. Complete pnpm txline:activate first.",
  );
}

const governor = new QuoteGovernor();
const controller = new AbortController();
const durationMs = readOptionalDuration();
const client = new TxLineClient({
  origin: config.txlineOrigin,
  apiToken: config.txlineApiToken,
});
const worker = new TxLineLiveWorker({
  client,
  callbacks: {
    onInput: async (input) => {
      const receipts = governor.process(input);
      for (const receipt of receipts) {
        await appendPrivateCapture("live-decisions.jsonl", receipt);
        console.log(
          JSON.stringify({
            type: "decision",
            action: receipt.body.action,
            trigger: receipt.body.trigger,
            fixtureId: receipt.body.fixtureId,
            hash: receipt.hash,
          }),
        );
      }
    },
    onStatus: async (status) => {
      const snapshot = {
        type: "worker-status" as const,
        ...status,
        updatedAt: new Date().toISOString(),
      };
      await writeRuntimeState("worker-status.json", snapshot);
      if (Date.now() - lastStatusLogAt >= 30_000 || !status.running) {
        console.log(JSON.stringify(snapshot));
        lastStatusLogAt = Date.now();
      }
    },
  },
});

let lastStatusLogAt = 0;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => controller.abort());
}

const durationTimeout = durationMs
  ? setTimeout(() => controller.abort(), durationMs)
  : undefined;
try {
  await worker.run(controller.signal);
} finally {
  if (durationTimeout) clearTimeout(durationTimeout);
}

function readOptionalDuration() {
  const index = process.argv.indexOf("--duration-ms");
  if (index === -1) return undefined;
  const duration = Number(process.argv[index + 1]);
  if (
    !Number.isInteger(duration) ||
    duration < 1_000 ||
    duration > 14_400_000
  ) {
    throw new Error("--duration-ms must be an integer from 1000 to 14400000");
  }
  return duration;
}
