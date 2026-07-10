import type { DecisionReceipt } from "../domain/types.js";

export interface PublicDecisionProjection {
  action: DecisionReceipt["body"]["action"];
  trigger: DecisionReceipt["body"]["trigger"];
  fromMode: DecisionReceipt["body"]["fromMode"];
  toMode: DecisionReceipt["body"]["toMode"];
  elapsedMs: number;
  receiptHash: string;
  configHash: string;
}

export function projectDecisionReceipt(
  receipt: DecisionReceipt,
  lifecycleStartedAt: number,
): PublicDecisionProjection {
  if (receipt.body.observedTs < lifecycleStartedAt) {
    throw new Error("Receipt predates the public lifecycle anchor");
  }
  return {
    action: receipt.body.action,
    trigger: receipt.body.trigger,
    fromMode: receipt.body.fromMode,
    toMode: receipt.body.toMode,
    elapsedMs: receipt.body.observedTs - lifecycleStartedAt,
    receiptHash: receipt.hash,
    configHash: receipt.body.configHash,
  };
}
