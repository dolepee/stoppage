import { sha256 as sha256Digest } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";

import {
  STOPPAGE_PERMIT_MAX_CLOCK_SKEW_MS,
  StoppageClient,
  runBenchLite,
  verifyPermit,
  type ExecutionIntent,
  type PermitVerificationKeySet,
  type PublicAgentResponseV2,
  type SignedExecutionPermitV2,
} from "./index.js";

const pair = nacl.sign.keyPair.fromSeed(
  Uint8Array.from({ length: 32 }, (_, index) => index),
);
const kid = `stp_${hashCanonical(Array.from(pair.publicKey)).slice(2, 18)}`;
const rotatedPair = nacl.sign.keyPair.fromSeed(
  Uint8Array.from({ length: 32 }, (_, index) => index + 32),
);
const rotatedKid = `stp_${hashCanonical(Array.from(rotatedPair.publicKey)).slice(2, 18)}`;
const keys: PermitVerificationKeySet = {
  version: 1,
  issuer: "stoppage",
  keys: [
    {
      kid,
      alg: "Ed25519",
      use: "sig",
      publicKey: encodeBase64Url(pair.publicKey),
      status: "ACTIVE",
    },
  ],
};
const rotatedKeys: PermitVerificationKeySet = {
  version: 1,
  issuer: "stoppage",
  keys: [
    {
      kid: rotatedKid,
      alg: "Ed25519",
      use: "sig",
      publicKey: encodeBase64Url(rotatedPair.publicKey),
      status: "ACTIVE",
    },
  ],
};

describe("@stoppage/sdk enforcement adapter", () => {
  it("verifies a Permit V2 offline and rejects a V1 object", () => {
    const now = Date.now();
    const intent = makeIntent("offline-nonce-0001");
    const permit = makePermit(intent, now);

    expect(verifyPermit({ permit, intent, keys, now: now + 1 })).toMatchObject({
      valid: true,
      decision: "ALLOW",
    });
    expect(
      verifyPermit({
        permit: { body: { version: 1 } } as never,
        intent,
        keys,
        now,
      }),
    ).toMatchObject({ valid: false, decision: "BLOCK_PERMIT_MALFORMED" });
  });

  it("rejects a valid signature from a retired verification key", () => {
    const now = Date.now();
    const intent = makeIntent("retired-key-nonce-0001");
    const permit = makePermit(intent, now);
    const retiredKeys = structuredClone(keys);
    retiredKeys.keys[0]!.status = "RETIRED";

    expect(
      verifyPermit({ permit, intent, keys: retiredKeys, now: now + 1 }),
    ).toMatchObject({
      valid: false,
      decision: "BLOCK_UNKNOWN_SIGNING_KEY",
    });
  });

  it("tolerates bounded signer clock skew while keeping expiry strict", () => {
    const now = Date.now();
    const intent = makeIntent("clock-skew-nonce-0001");
    const permit = makePermit(intent, now);
    const verifyAt = (verificationTime: number) =>
      verifyPermit({ permit, intent, keys, now: verificationTime });

    expect(verifyAt(now - STOPPAGE_PERMIT_MAX_CLOCK_SKEW_MS)).toMatchObject({
      valid: true,
      decision: "ALLOW",
    });
    expect(verifyAt(now - STOPPAGE_PERMIT_MAX_CLOCK_SKEW_MS - 1)).toMatchObject(
      {
        valid: false,
        decision: "BLOCK_PERMIT_EXPIRED",
      },
    );
    expect(verifyAt(permit.body.expiresAt)).toMatchObject({
      valid: false,
      decision: "BLOCK_PERMIT_EXPIRED",
    });
  });

  it("fails closed on an explicitly malformed verification timestamp", () => {
    const now = Date.now();
    const intent = makeIntent("malformed-time-nonce-0001");
    const permit = makePermit(intent, now);
    const client = new StoppageClient({ keySet: keys });

    expect(
      client.verifyPermit(permit, intent, keys, null as never),
    ).toMatchObject({
      valid: false,
      decision: "BLOCK_PERMIT_EXPIRED",
    });
  });

  it("never invokes the venue callback on a BLOCK decision", async () => {
    const intent = makeIntent("blocked-nonce-0001");
    const callback = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        ...makeResponse(intent, Date.now()),
        result: {
          version: 2,
          command: "PUBLISH_QUOTE",
          decision: "BLOCK_UNRESOLVED_INCIDENT",
          reason: "Uncertainty",
          evaluatedAt: Date.now(),
          sequence: intent.sequence,
          permit: null,
        },
      }),
    );
    const client = new StoppageClient({ fetch, keySet: keys });

    const outcome = await client.guardAction(intent, callback);

    expect(outcome.status).toBe("VENUE_CALL_WITHHELD");
    expect(callback).not.toHaveBeenCalled();
  });

  it("claims a nonce before callback invocation so concurrent replay executes once", async () => {
    const now = Date.now();
    const intent = makeIntent("one-use-nonce-0001");
    const response = makeResponse(intent, now);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => jsonResponse(response));
    const callback = vi.fn(async () => "venue-receipt");
    const client = new StoppageClient({ fetch, keySet: keys });

    const outcomes = await Promise.all([
      client.guardAction(intent, callback),
      client.guardAction(intent, callback),
    ]);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "VENUE_CALL_EXECUTED",
      "VENUE_CALL_WITHHELD",
    ]);
    expect(
      outcomes.find((outcome) => outcome.status === "VENUE_CALL_WITHHELD")
        ?.verification.decision,
    ).toBe("BLOCK_NONCE_REPLAY");
  });

  it("rejects replay through a second client instance in the same SDK runtime", async () => {
    const now = Date.now();
    const intent = makeIntent("cross-client-nonce-0001");
    const response = makeResponse(intent, now);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => jsonResponse(response));
    const callback = vi.fn(() => "venue-receipt");
    const firstClient = new StoppageClient({ fetch, keySet: keys });
    const secondClient = new StoppageClient({ fetch, keySet: keys });

    await expect(
      firstClient.guardAction(intent, callback),
    ).resolves.toMatchObject({ status: "VENUE_CALL_EXECUTED" });
    await expect(
      secondClient.guardAction(intent, callback),
    ).resolves.toMatchObject({
      status: "VENUE_CALL_WITHHELD",
      verification: { decision: "BLOCK_NONCE_REPLAY" },
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not let caller-supplied time evict another client's live nonce claim", async () => {
    const now = Date.now();
    const intent = makeIntent("future-prune-nonce-0001");
    const response = makeResponse(intent, now);
    const permit = response.result.permit;
    if (!permit)
      throw new Error("Expected the allowed response to include Permit V2");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => jsonResponse(response));
    const callback = vi.fn(() => "venue-receipt");
    const firstClient = new StoppageClient({ fetch, keySet: keys });
    const secondClient = new StoppageClient({ fetch, keySet: keys });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      await expect(
        firstClient.guardAction(intent, callback),
      ).resolves.toMatchObject({ status: "VENUE_CALL_EXECUTED" });

      expect(
        secondClient.verifyPermit(permit, intent, keys, permit.body.expiresAt),
      ).toMatchObject({
        valid: false,
        decision: "BLOCK_PERMIT_EXPIRED",
      });

      await expect(
        firstClient.guardAction(intent, callback),
      ).resolves.toMatchObject({
        status: "VENUE_CALL_WITHHELD",
        verification: { decision: "BLOCK_NONCE_REPLAY" },
      });
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("uses one wall-clock reading at the nonce-expiry boundary", async () => {
    const now = Date.now();
    const intent = makeIntent("expiry-boundary-nonce-0001");
    const response = makeResponse(intent, now);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => jsonResponse(response));
    const callback = vi.fn(() => "venue-receipt");
    const client = new StoppageClient({ fetch, keySet: keys });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      await expect(client.guardAction(intent, callback)).resolves.toMatchObject(
        { status: "VENUE_CALL_EXECUTED" },
      );

      clock.mockClear();
      clock
        .mockReturnValueOnce(response.result.evaluatedAt + 4_999)
        .mockReturnValue(response.result.evaluatedAt + 5_000);
      await expect(client.guardAction(intent, callback)).resolves.toMatchObject(
        {
          status: "VENUE_CALL_WITHHELD",
          verification: { decision: "BLOCK_NONCE_REPLAY" },
        },
      );
      expect(clock).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("prunes consumed nonces after their five-second permit lifetime", async () => {
    const now = Date.now();
    const intent = makeIntent("expiring-replay-nonce-0001");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(makeResponse(intent, now)))
      .mockResolvedValueOnce(jsonResponse(makeResponse(intent, now + 5_001)));
    const callback = vi.fn(() => "venue-receipt");
    const client = new StoppageClient({ fetch, keySet: keys });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      await expect(client.guardAction(intent, callback)).resolves.toMatchObject(
        {
          status: "VENUE_CALL_EXECUTED",
        },
      );
      clock.mockReturnValue(now + 5_001);
      await expect(client.guardAction(intent, callback)).resolves.toMatchObject(
        {
          status: "VENUE_CALL_EXECUTED",
        },
      );
      expect(callback).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("runs all six Bench Lite attacks through the offline SDK verifier", () => {
    const now = Date.now();
    const intent = makeIntent("bench-lite-nonce-0001");
    const permit = makePermit(intent, now);

    expect(runBenchLite({ permit, intent, keys })).toMatchObject([
      {
        challenge: "QUOTE_TAMPER",
        valid: false,
        decision: "BLOCK_SIGNATURE_INVALID",
      },
      {
        challenge: "RECEIPT_TAMPER",
        valid: false,
        decision: "BLOCK_SIGNATURE_INVALID",
      },
      {
        challenge: "EXPIRED_REPLAY",
        valid: false,
        decision: "BLOCK_PERMIT_EXPIRED",
      },
      {
        challenge: "WRONG_AUDIENCE",
        valid: false,
        decision: "BLOCK_AUDIENCE_MISMATCH",
      },
      {
        challenge: "UNKNOWN_SIGNING_KEY",
        valid: false,
        decision: "BLOCK_UNKNOWN_SIGNING_KEY",
      },
      {
        challenge: "REUSED_NONCE",
        valid: false,
        decision: "BLOCK_NONCE_REPLAY",
      },
    ]);
  });

  it("bypasses cached key discovery when the signer rotates", async () => {
    const now = Date.now();
    const intent = makeIntent("rotated-key-nonce-0001");
    const response = makeResponse(intent, now, rotatedPair, rotatedKid);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(response))
      .mockResolvedValueOnce(jsonResponse(rotatedKeys));
    const callback = vi.fn(() => "venue-receipt");
    const client = new StoppageClient({ fetch, keySet: keys });

    const outcome = await client.guardAction(intent, callback);

    expect(outcome.status).toBe("VENUE_CALL_EXECUTED");
    expect(callback).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: "GET",
      cache: "no-store",
    });
  });
});

function makeIntent(nonce: string): ExecutionIntent {
  return {
    version: 2,
    agentId: "clean-consumer-agent",
    audience: "venue:clean-consumer-agent",
    nonce,
    command: "PUBLISH_QUOTE",
    sequence: 12,
    subjectHash: `0x${"1".repeat(64)}`,
    market: "1X2",
    quoteHash: `0x${"2".repeat(64)}`,
  };
}

function makeResponse(
  intent: ExecutionIntent,
  now: number,
  signingPair: typeof pair = pair,
  signingKid = kid,
): PublicAgentResponseV2 {
  const permit = makePermit(intent, now, signingPair, signingKid);
  return {
    version: 2,
    dataMode: "SYNTHETIC",
    scenario: "test",
    agent: { id: intent.agentId, automated: true },
    transport: {
      protocol: "HTTPS",
      endpoint: "/api/agent-gate",
      keyEndpoint: "/api/permit-keys",
      requestId: `0x${"9".repeat(64)}`,
    },
    request: intent,
    result: {
      version: 2,
      command: "PUBLISH_QUOTE",
      decision: "ALLOW_CERTIFIED_REOPEN",
      reason: permit.body.reason,
      evaluatedAt: now,
      sequence: intent.sequence,
      permit,
    },
    challenge: null,
  };
}

function makePermit(
  intent: ExecutionIntent,
  now: number,
  signingPair: typeof pair = pair,
  signingKid = kid,
): SignedExecutionPermitV2 {
  const body = {
    version: 2 as const,
    issuer: "stoppage",
    kid: signingKid,
    agentId: intent.agentId,
    audience: intent.audience,
    nonce: intent.nonce,
    command: intent.command,
    decision: "ALLOW_CERTIFIED_REOPEN" as const,
    reason: "Certified",
    subjectHash: intent.subjectHash,
    market: intent.market,
    quoteHash: intent.quoteHash,
    configHash: `0x${"3".repeat(64)}`,
    stateReceiptHash: `0x${"4".repeat(64)}`,
    reopenProofHash: `0x${"5".repeat(64)}`,
    sequence: intent.sequence,
    issuedAt: now,
    expiresAt: now + 5_000,
  };
  const signature = nacl.sign.detached(
    utf8ToBytes(canonicalJson({ kind: "STOPPAGE_EXECUTION_PERMIT_V2", body })),
    signingPair.secretKey,
  );
  return {
    alg: "Ed25519",
    body,
    hash: hashCanonical(body),
    signature: encodeBase64Url(signature),
  };
}

function hashCanonical(value: unknown): string {
  return `0x${bytesToHex(sha256Digest(utf8ToBytes(canonicalJson(value))))}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  }
  return value;
}

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
