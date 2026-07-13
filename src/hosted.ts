import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createApplication } from "./app.js";

const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
const { app, config } = await createApplication();
let worker: ChildProcess | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let stopping = false;

function startWorker() {
  if (stopping) return;
  worker = spawn(process.execPath, [workerPath], {
    env: process.env,
    stdio: "inherit",
  });
  worker.once("exit", (code, signal) => {
    worker = null;
    if (stopping) return;
    app.log.error({ code, signal }, "live worker exited; restarting");
    restartTimer = setTimeout(startWorker, 2_000);
  });
}

async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (worker && !worker.killed) worker.kill(signal);
  await app.close();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}

startWorker();
await app.listen({ host: config.host, port: config.port });
