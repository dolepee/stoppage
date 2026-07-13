import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

describe("private capture store", () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.STOPPAGE_PRIVATE_ROOT;
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("serializes concurrent JSONL appends", async () => {
    root = await mkdtemp(join(tmpdir(), "stoppage-capture-"));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const { appendPrivateCapture } = await import("./capture-store.js");

    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        appendPrivateCapture("dual-stream.jsonl", {
          index,
          payload: "x".repeat(8_192),
        }),
      ),
    );

    const lines = (
      await readFile(join(root, "data/private/dual-stream.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { index: number });
    expect(lines).toHaveLength(100);
    expect(lines.map((line) => line.index).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, index) => index),
    );
  });

  it("supports a private persistent-volume root", async () => {
    root = await mkdtemp(join(tmpdir(), "stoppage-capture-volume-"));
    process.env.STOPPAGE_PRIVATE_ROOT = root;
    const { writePrivateCapture } = await import("./capture-store.js");

    const path = await writePrivateCapture("capture.json", { private: true });

    expect(path).toBe(join(root, "capture.json"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ private: true });
  });
});
