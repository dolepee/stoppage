import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256 } from "../domain/canonical.js";
import type { ExecutionGateResult } from "./types.js";
import {
  createPermitSigner,
  inspectExecutionPermitV2,
  issueExecutionPermitV2,
  loadPermitSigner,
  loadRetiredPermitVerificationKeys,
  nonceKey,
  publicKeySetFor,
  type PermitV2RequestBinding,
} from "./permit-v2.js";

const signer = createPermitSigner(Uint8Array.from({ length: 32 }, (_, i) => i));

describe("authenticated execution permit v2", () => {
  it("loads retired verification keys from JSON configuration", () => {
    const retiredSigner = createPermitSigner(
      Uint8Array.from({ length: 32 }, (_, index) => 64 + index),
    );
    expect(
      loadRetiredPermitVerificationKeys({
        STOPPAGE_PERMIT_RETIRED_VERIFICATION_KEYS: JSON.stringify([
          {
            kid: retiredSigner.kid,
            publicKey: Buffer.from(retiredSigner.publicKey).toString(
              "base64url",
            ),
          },
        ]),
      }),
    ).toEqual([
      {
        kid: retiredSigner.kid,
        alg: "Ed25519",
        use: "sig",
        status: "RETIRED",
        publicKey: Buffer.from(retiredSigner.publicKey).toString("base64url"),
      },
    ]);
  });

  it("rejects malformed retired key configuration", () => {
    expect(() =>
      loadRetiredPermitVerificationKeys({
        STOPPAGE_PERMIT_RETIRED_VERIFICATION_KEYS: "not-json",
      }),
    ).toThrow("must be JSON");
  });

  it("loads a dedicated raw signing seed from an ignored file", () => {
    const root = mkdtempSync(join(tmpdir(), "stoppage-permit-seed-"));
    const path = join(root, "permit.seed");
    try {
      writeFileSync(
        path,
        Uint8Array.from({ length: 32 }, (_, index) => index),
      );
      chmodSync(path, 0o600);
      expect(
        loadPermitSigner({
          NODE_ENV: "production",
          STOPPAGE_PERMIT_SIGNING_SEED_FILE: path,
        }).kid,
      ).toBe(signer.kid);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects signing seed files readable by another user", () => {
    const root = mkdtempSync(join(tmpdir(), "stoppage-permit-seed-"));
    const path = join(root, "permit.seed");
    try {
      writeFileSync(
        path,
        Uint8Array.from({ length: 32 }, (_, index) => index),
      );
      chmodSync(path, 0o644);

      expect(() =>
        loadPermitSigner({
          NODE_ENV: "production",
          STOPPAGE_PERMIT_SIGNING_SEED_FILE: path,
        }),
      ).toThrow("Stoppage signing seed file permissions must be 0600");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies a signed permit offline against discovered public keys", () => {
    const { result, request } = allowedResult();
    const signed = issueExecutionPermitV2(result, request, signer, 10_000);

    expect(signed.permit).not.toBeNull();
    expect(
      inspectExecutionPermitV2({
        permit: signed.permit!,
        request,
        keys: publicKeySetFor(signer),
        now: 10_001,
      }),
    ).toEqual({
      valid: true,
      decision: "ALLOW",
      reason: "The signed permit authorizes this exact action.",
    });
  });

  it("never signs a blocked decision", () => {
    const result: ExecutionGateResult = {
      version: 1,
      command: "PUBLISH_QUOTE",
      decision: "BLOCK_UNRESOLVED_INCIDENT",
      reason: "Blocked",
      evaluatedAt: 10_000,
      sequence: 2,
      permit: null,
    };

    expect(
      issueExecutionPermitV2(result, requestBinding(), signer).permit,
    ).toBeNull();
  });

  it("rejects a valid permit when the intended sequence has advanced", () => {
    const { result, request } = allowedResult();
    const signed = issueExecutionPermitV2(result, request, signer, 10_000);

    expect(
      inspectExecutionPermitV2({
        permit: signed.permit!,
        request: { ...request, sequence: request.sequence + 1 },
        keys: publicKeySetFor(signer),
        now: 10_001,
      }),
    ).toMatchObject({
      valid: false,
      decision: "BLOCK_BINDING_INVALID",
    });
  });

  it("rejects a valid signature from a retired verification key", () => {
    const { result, request } = allowedResult();
    const signed = issueExecutionPermitV2(result, request, signer, 10_000);
    const keys = publicKeySetFor(signer);
    keys.keys[0]!.status = "RETIRED";

    expect(
      inspectExecutionPermitV2({
        permit: signed.permit!,
        request,
        keys,
        now: 10_001,
      }),
    ).toMatchObject({
      valid: false,
      decision: "BLOCK_UNKNOWN_SIGNING_KEY",
    });
  });

  it("tolerates bounded verifier clock skew without weakening expiry", () => {
    const { result, request } = allowedResult();
    const signed = issueExecutionPermitV2(result, request, signer, 10_000);
    const inspectAt = (now: number) =>
      inspectExecutionPermitV2({
        permit: signed.permit!,
        request,
        keys: publicKeySetFor(signer),
        now,
      });

    expect(inspectAt(9_000)).toMatchObject({ valid: true, decision: "ALLOW" });
    expect(inspectAt(8_999)).toMatchObject({
      valid: false,
      decision: "BLOCK_PERMIT_EXPIRED",
    });
    expect(inspectAt(15_000)).toMatchObject({
      valid: false,
      decision: "BLOCK_PERMIT_EXPIRED",
    });
  });

  it.each([
    "quote tamper",
    "receipt tamper",
    "expired permit",
    "wrong audience",
    "unknown signing key",
    "reused nonce",
  ] as const)("rejects %s before execution", (attack) => {
    const { result, request } = allowedResult();
    const signed = issueExecutionPermitV2(result, request, signer, 10_000);
    const permit = structuredClone(signed.permit!);
    const expected = { ...request };
    const usedNonces = new Set<string>();
    let now = 10_001;

    if (attack === "quote tamper") {
      permit.body.quoteHash = differentHash(permit.body.quoteHash);
      permit.hash = sha256(permit.body);
    } else if (attack === "receipt tamper") {
      permit.body.stateReceiptHash = differentHash(
        permit.body.stateReceiptHash!,
      );
      permit.hash = sha256(permit.body);
    } else if (attack === "expired permit") {
      now = permit.body.expiresAt;
    } else if (attack === "wrong audience") {
      expected.audience = "venue:wrong-agent";
    } else if (attack === "unknown signing key") {
      permit.body.kid = "stp_unknown000000";
      permit.hash = sha256(permit.body);
    } else {
      usedNonces.add(nonceKey(permit.body));
    }

    expect(
      inspectExecutionPermitV2({
        permit,
        request: expected,
        keys: publicKeySetFor(signer),
        now,
        usedNonces,
      }),
    ).toMatchObject({
      valid: false,
      decision: expect.stringMatching(/^BLOCK_/),
    });
  });
});

function allowedResult() {
  const request = requestBinding();
  const body = {
    version: 1,
    decision: "ALLOW_CERTIFIED_REOPEN" as const,
    reason: "Certified",
    subjectHash: request.subjectHash,
    market: "1X2",
    quoteHash: request.quoteHash,
    configHash: `0x${"3".repeat(64)}`,
    stateReceiptHash: `0x${"4".repeat(64)}`,
    reopenProofHash: `0x${"5".repeat(64)}`,
    sequence: 12,
    issuedAt: 9_000,
    expiresAt: 14_000,
  } as const;
  const result: ExecutionGateResult = {
    version: 1,
    command: "PUBLISH_QUOTE",
    decision: body.decision,
    reason: body.reason,
    evaluatedAt: body.issuedAt,
    sequence: body.sequence,
    permit: { body, hash: sha256(body) },
  };
  return { result, request };
}

function requestBinding(): PermitV2RequestBinding {
  return {
    agentId: "judge-market-maker-v2",
    audience: "venue:judge-market-maker-v2",
    nonce: "request-nonce-0001",
    command: "PUBLISH_QUOTE",
    subjectHash: `0x${"1".repeat(64)}`,
    market: "1X2",
    quoteHash: `0x${"2".repeat(64)}`,
    sequence: 12,
  };
}

function differentHash(value: string): string {
  return `${value.slice(0, -1)}${value.endsWith("0") ? "1" : "0"}`;
}
