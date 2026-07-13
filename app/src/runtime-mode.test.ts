import { describe, expect, it } from "vitest";
import { resolveRuntimeMode } from "./runtime-mode";

describe("resolveRuntimeMode", () => {
  it("defaults the full Node deployment to API mode", () => {
    expect(resolveRuntimeMode(undefined)).toBe("api");
  });

  it("supports a static judge deployment without probing missing APIs", () => {
    expect(resolveRuntimeMode("local")).toBe("local");
  });

  it("rejects misspelled deployment modes", () => {
    expect(() => resolveRuntimeMode("static")).toThrow(
      "Unsupported VITE_RUNTIME_MODE",
    );
  });
});
