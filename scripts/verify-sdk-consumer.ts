import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const builtServer = join(root, "dist/server/server.js");
const temporaryRoot = await mkdtemp(join(tmpdir(), "stoppage-sdk-consumer-"));
const artifactRoot = join(temporaryRoot, "artifacts");
const consumerRoot = join(temporaryRoot, "consumer");

try {
  await access(builtServer).catch(() => {
    throw new Error("Build Stoppage before running the clean-consumer check");
  });
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(consumerRoot, { recursive: true });
  await execFileAsync(
    "pnpm",
    ["--dir", "packages/sdk", "pack", "--pack-destination", artifactRoot],
    { cwd: root },
  );
  const artifact = (await readdir(artifactRoot)).find((file) =>
    file.endsWith(".tgz"),
  );
  if (!artifact) throw new Error("The SDK tarball was not produced");

  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "stoppage-clean-consumer",
        private: true,
        type: "module",
        dependencies: {
          "@stoppage/sdk": `file:${join(artifactRoot, artifact)}`,
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(consumerRoot, "consumer.mjs"), cleanConsumerSource());
  await execFileAsync(
    "pnpm",
    ["install", "--ignore-scripts", "--no-frozen-lockfile"],
    { cwd: consumerRoot },
  );

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [builtServer], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForHealth(baseUrl, server);
    const result = await execFileAsync(process.execPath, ["consumer.mjs"], {
      cwd: consumerRoot,
      env: { ...process.env, STOPPAGE_URL: baseUrl },
    });
    process.stdout.write(result.stdout);
  } finally {
    server.kill("SIGTERM");
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a local verification port");
  }
  await new Promise<void>((resolvePromise) =>
    server.close(() => resolvePromise()),
  );
  return address.port;
}

async function waitForHealth(
  baseUrl: string,
  server: ReturnType<typeof spawn>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Stoppage test server exited with ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Timed out waiting for the Stoppage test server");
}

function cleanConsumerSource(): string {
  return `import { StoppageClient } from "@stoppage/sdk";

const baseUrl = process.env.STOPPAGE_URL;
if (!baseUrl) throw new Error("STOPPAGE_URL is required");

await fetch(\`\${baseUrl}/api/replay/start\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ speed: 16 }),
});

let snapshot;
for (let attempt = 0; attempt < 200; attempt += 1) {
  const response = await fetch(\`\${baseUrl}/api/status\`);
  snapshot = await response.json();
  if (snapshot.replayStatus === "COMPLETE") break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (snapshot?.replayStatus !== "COMPLETE") {
  throw new Error("Public replay did not reach Certified Reopen");
}

const intent = {
  version: 2,
  agentId: "clean-consumer-agent",
  audience: "venue:clean-consumer-agent",
  nonce: "clean-consumer-nonce-0001",
  command: "PUBLISH_QUOTE",
  sequence: snapshot.execution.sequence,
  subjectHash: snapshot.execution.subjectHash,
  market: "1X2",
  quoteHash: snapshot.execution.agent.requestedQuoteHash,
};
const client = new StoppageClient({ baseUrl });
let venueCalls = 0;
const execute = () => {
  venueCalls += 1;
  return "simulated-venue-receipt";
};
const first = await client.guardAction(intent, execute);
const replay = await client.guardAction(intent, execute);

if (first.status !== "VENUE_CALL_EXECUTED") {
  throw new Error(\`Expected execution, received \${first.verification.decision}\`);
}
if (
  replay.status !== "VENUE_CALL_WITHHELD" ||
  replay.verification.decision !== "BLOCK_NONCE_REPLAY"
) {
  throw new Error("The packaged SDK did not reject nonce replay");
}
if (venueCalls !== 1) throw new Error(\`Venue callback ran \${venueCalls} times\`);

console.log("clean consumer: Permit V2 verified; venue callback executed once; replay withheld");
`;
}
