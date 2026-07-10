import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = resolve(
  process.env.STOPPAGE_RUNTIME_ROOT ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../..", "data/runtime"),
);

export async function writeRuntimeState(name: string, value: unknown) {
  const path = runtimePath(name);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(value)}\n`;
  await writeFile(temporary, payload, { mode: 0o600 });
  try {
    try {
      await rename(temporary, path);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      // Defensive fallback for transient runtime-path issues under launchd and filesystem edge cases.
      if (nodeError.code === "ENOENT" || nodeError.code === "EXDEV") {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, payload, { mode: 0o600 });
        return path;
      }
      throw error;
    }
    await chmod(path, 0o600);
    return path;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readRuntimeState<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(runtimePath(name), "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function runtimePath(name: string) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error(`Unsafe runtime state name: ${name}`);
  }
  const path = resolve(runtimeRoot, name);
  if (!path.startsWith(`${runtimeRoot}/`)) {
    throw new Error("Runtime state escaped private root");
  }
  return path;
}
