import { describe, expect, it } from "vitest";
import {
  scrubApprovedLiveDecisionTapeHashes,
  scrubApprovedPublicClaimHashes,
} from "./public-hash-scrub.js";

const digest = `0x${"a".repeat(64)}`;
const unknownHash = `0x${"b".repeat(64)}`;
const permitHash = `0x${"c".repeat(64)}`;
const subjectHash = `0x${"d".repeat(64)}`;
const quoteHash = `0x${"e".repeat(64)}`;
const callbackReceiptHash = `0x${"f".repeat(64)}`;

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

describe("scrubApprovedLiveDecisionTapeHashes", () => {
  it("scrubs only the candidate and signed sample bindings", () => {
    const content = JSON.stringify({
      candidateHash: digest,
      sampleProof: {
        permit: {
          hash: permitHash,
          body: {
            subjectHash,
            quoteHash,
          },
        },
        intendedAgent: {
          callbackReceiptHash,
        },
      },
      unrelated: unknownHash,
    });

    const scrubbed = scrubApprovedLiveDecisionTapeHashes(content);
    expect(scrubbed).not.toContain(digest);
    expect(scrubbed).not.toContain(subjectHash);
    expect(scrubbed).not.toContain(callbackReceiptHash);
    expect(scrubbed).toContain(unknownHash);
  });
});
