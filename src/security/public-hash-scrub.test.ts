import { describe, expect, it } from "vitest";
import { scrubApprovedPublicClaimHashes } from "./public-hash-scrub.js";

const digest = `0x${"a".repeat(64)}`;
const unknownHash = `0x${"b".repeat(64)}`;

describe("scrubApprovedPublicClaimHashes", () => {
  it("scrubs explicitly labeled candidate hashes", () => {
    const content = JSON.stringify({
      candidateHash: digest,
      approval: { statement: `APPROVE STOPPAGE PUBLIC CLAIM ${digest}` },
    });

    const scrubbed = scrubApprovedPublicClaimHashes(content);

    expect(scrubbed).not.toContain(digest);
    expect(scrubbed).toContain("<approved-public-hash>");
  });

  it("does not scrub unlabeled 32-byte values", () => {
    const content = JSON.stringify({
      candidateHash: digest,
      unrelated: unknownHash,
    });

    expect(scrubApprovedPublicClaimHashes(content)).toContain(unknownHash);
  });
});
