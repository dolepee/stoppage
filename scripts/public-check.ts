import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";

const repositoryRoot = new URL("../", import.meta.url);
const listed = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: repositoryRoot, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);

const forbiddenPaths = [
  /(^|\/)\.secrets\//,
  /(^|\/)data\/(raw|private|runtime)\//,
  /TXODDS_STOPPAGE_MASTER_PLAN\.md$/,
  /(^|\/)(demo[_-]?script|recording[_-]?script|judge[_-]?script)/i,
  /(^|\/)(submission[_-]?checklist)/i,
];

const requiredDockerIgnores = [
  ".env",
  ".env.*",
  ".secrets",
  "data",
  "TXODDS_STOPPAGE_MASTER_PLAN.md",
];

const secretPatterns: Array<[string, RegExp]> = [
  ["GitHub token", /\bgh[opsu]_[A-Za-z0-9_]{20,}\b/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/],
  ["PEM private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["EVM private key", /\b0x[0-9a-fA-F]{64}\b/],
];

const failures: string[] = [];

if (listed.includes("Dockerfile")) {
  const dockerIgnore = listed.includes(".dockerignore")
    ? await readFile(new URL(".dockerignore", repositoryRoot), "utf8")
    : "";
  for (const required of requiredDockerIgnores) {
    if (!dockerIgnore.split(/\r?\n/).includes(required)) {
      failures.push(`.dockerignore is missing: ${required}`);
    }
  }
}

for (const path of listed) {
  // Public claim payload intentionally carries on-chain hashes and is reviewed separately.
  if (path === "data/public/public-claim.json") {
    continue;
  }
  if (
    (path === ".env" || path.startsWith(".env.")) &&
    path !== ".env.example"
  ) {
    failures.push(`Forbidden private file: ${path}`);
    continue;
  }
  if (forbiddenPaths.some((pattern) => pattern.test(path))) {
    failures.push(`Forbidden private file: ${path}`);
    continue;
  }

  const url = new URL(path, repositoryRoot);
  const metadata = await stat(url);
  if (!metadata.isFile() || metadata.size > 2_000_000) continue;
  const content = await readFile(url, "utf8");
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(content)) failures.push(`${label} pattern in ${path}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Public gate passed for ${listed.length} repository files.`);
}
