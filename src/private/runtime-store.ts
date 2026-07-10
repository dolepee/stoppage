import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const runtimeRoot = resolve("data/runtime");

export async function writeRuntimeState(name: string, value: unknown) {
  const path = runtimePath(name);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
  return path;
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
