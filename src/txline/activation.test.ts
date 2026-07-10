import { describe, expect, it } from "vitest";

import { parseActivationToken } from "./activation.js";

describe("parseActivationToken", () => {
  it("accepts the plain-text response used by TxLINE", () => {
    expect(parseActivationToken("txoracle_api_abc123\n")).toBe(
      "txoracle_api_abc123",
    );
  });

  it("accepts legacy JSON token responses", () => {
    expect(parseActivationToken('{"token":"txoracle_api_abc123"}')).toBe(
      "txoracle_api_abc123",
    );
    expect(parseActivationToken('"txoracle_api_abc123"')).toBe(
      "txoracle_api_abc123",
    );
  });

  it("rejects empty or error-page responses", () => {
    expect(() => parseActivationToken("  ")).toThrow(/empty token/);
    expect(() => parseActivationToken("<html>upstream error</html>")).toThrow(
      /unrecognized token format/,
    );
  });
});
