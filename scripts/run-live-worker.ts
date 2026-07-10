import { QuoteGovernor } from "../src/domain/governor.js";
import { loadConfig } from "../src/config.js";
import { TxLineLiveWorker } from "../src/live/txline-live-worker.js";
import { appendPrivateCapture } from "../src/private/capture-store.js";
import { TxLineClient } from "../src/txline/client.js";

const config = loadConfig();
if (!config.txlineApiToken) {
  throw new Error(
    "TXLINE_API_TOKEN is required. Complete pnpm txline:activate first.",
  );
}

const governor = new QuoteGovernor();
const controller = new AbortController();
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
    onStatus: (status) => {
      console.log(JSON.stringify({ type: "worker-status", ...status }));
    },
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => controller.abort());
}

await worker.run(controller.signal);
