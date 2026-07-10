import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const privateRoot = resolve("data/private");

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
