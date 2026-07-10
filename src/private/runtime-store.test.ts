import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

describe("runtime state store", () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("writes and reads compact state atomically", async () => {
    root = await mkdtemp(join(tmpdir(), "stoppage-runtime-"));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const { readRuntimeState, writeRuntimeState } =
      await import("./runtime-store.js");

    const path = await writeRuntimeState("worker.json", { running: true });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ running: true });
    await expect(readRuntimeState("worker.json")).resolves.toEqual({
      running: true,
    });
  });
});
