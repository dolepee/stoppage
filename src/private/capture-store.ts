import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

const privateRoot = resolve(
  process.env.STOPPAGE_PRIVATE_ROOT ?? "data/private",
);
const appendQueues = new Map<string, Promise<void>>();

export interface PrivateUseClaim {
  namespace: string;
  key: string;
  expiresAt: number;
  now?: number;
}

export async function writePrivateCapture(
  name: string,
  value: unknown,
): Promise<string> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error(`Unsafe capture name: ${name}`);
  }

  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await chmod(privateRoot, 0o700);
  const path = resolve(privateRoot, name);
  if (!path.startsWith(`${privateRoot}/`))
    throw new Error("Capture escaped private root");
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function appendPrivateCapture(
  name: string,
  value: unknown,
): Promise<string> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error(`Unsafe capture name: ${name}`);
  }
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await chmod(privateRoot, 0o700);
  const path = resolve(privateRoot, name);
  if (!path.startsWith(`${privateRoot}/`))
    throw new Error("Capture escaped private root");
  const previous = appendQueues.get(path) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    });
  appendQueues.set(path, operation);
  try {
    await operation;
  } finally {
    if (appendQueues.get(path) === operation) appendQueues.delete(path);
  }
  return path;
}

export async function claimPrivateUse({
  namespace,
  key,
  expiresAt,
  now = Date.now(),
}: PrivateUseClaim): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/i.test(namespace)) {
    throw new Error("Unsafe private-use claim namespace");
  }
  if (key.length < 8 || key.length > 512) {
    throw new Error("Private-use claim key is malformed");
  }
  if (
    !Number.isInteger(now) ||
    !Number.isInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt - now > 10_000
  ) {
    throw new Error("Private-use claim expiry is invalid");
  }

  const claimsRoot = resolve(privateRoot, ".claims", namespace);
  if (!claimsRoot.startsWith(`${privateRoot}/`)) {
    throw new Error("Private-use claim escaped private root");
  }
  await mkdir(claimsRoot, { recursive: true, mode: 0o700 });
  await chmod(claimsRoot, 0o700);
  await pruneExpiredClaims(claimsRoot, now);

  const digest = createHash("sha256").update(key).digest("hex");
  const path = resolve(claimsRoot, `${digest}.claim`);
  try {
    await writeFile(path, `${JSON.stringify({ expiresAt })}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function pruneExpiredClaims(root: string, now: number) {
  const names = await readdir(root);
  await Promise.all(
    names
      .filter((name) => /^[0-9a-f]{64}\.claim$/.test(name))
      .map(async (name) => {
        const path = resolve(root, name);
        try {
          const claim = JSON.parse(await readFile(path, "utf8")) as {
            expiresAt?: unknown;
          };
          const claimExpiry = claim.expiresAt;
          if (
            typeof claimExpiry === "number" &&
            Number.isInteger(claimExpiry) &&
            claimExpiry <= now
          ) {
            await rm(path, { force: true });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            // A malformed claim remains fail-closed instead of becoming reusable.
          }
        }
      }),
  );
}
