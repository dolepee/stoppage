export function scrubApprovedPublicClaimHashes(content: string) {
  const claim = JSON.parse(content) as {
    approvedConfigHash?: string;
    candidateHash?: string;
    lifecycleEvidence?: { decisions?: Array<{ receiptHash?: string }> };
  };
  const approvedHashes = [
    claim.approvedConfigHash,
    claim.candidateHash,
    ...(claim.lifecycleEvidence?.decisions ?? []).map(
      (decision) => decision.receiptHash,
    ),
  ].filter((value): value is string => Boolean(value));

  return approvedHashes.reduce(
    (scrubbed, hash) => scrubbed.replaceAll(hash, "<approved-public-hash>"),
    content,
  );
}

export function scrubApprovedLiveDecisionTapeHashes(content: string) {
  const tape = JSON.parse(content) as {
    candidateHash?: string;
    sampleProof?: {
      permit?: {
        hash?: string;
        body?: {
          subjectHash?: string;
          quoteHash?: string;
          configHash?: string;
          stateReceiptHash?: string | null;
          reopenProofHash?: string | null;
        };
      };
    };
  };
  const body = tape.sampleProof?.permit?.body;
  const approvedHashes = [
    tape.candidateHash,
    tape.sampleProof?.permit?.hash,
    body?.subjectHash,
    body?.quoteHash,
    body?.configHash,
    body?.stateReceiptHash,
    body?.reopenProofHash,
  ].filter((value): value is string => Boolean(value));

  return approvedHashes.reduce(
    (scrubbed, hash) => scrubbed.replaceAll(hash, "<approved-live-tape-hash>"),
    content,
  );
}
