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
