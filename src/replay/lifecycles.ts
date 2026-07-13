import { maximumProbabilityMove } from "../domain/probability.js";
import type {
  ConsensusQuote,
  DecisionReceipt,
  GovernorInput,
  MatchEvent,
} from "../domain/types.js";

export interface CompleteLifecycle {
  trigger: string;
  eventType: string | null;
  sourceEventId: string | null;
  suspendTs: number;
  repriceTs: number;
  reopenTs: number;
  suspensionMs: number;
  repriceToReopenMs: number;
  maximumProbabilityMove: number | null;
  suspendHash: string;
  repriceHash: string;
  reopenHash: string;
  decisionHashes: string[];
  preResolutionRepricesInvalidated: number;
}

export function completeLifecycles(
  receipts: DecisionReceipt[],
  inputs: GovernorInput[],
): CompleteLifecycle[] {
  const quoteInputs = inputs.filter(
    (input): input is ConsensusQuote => input.kind === "quote",
  );
  const eventInputs = new Map(
    inputs
      .filter((input): input is MatchEvent => input.kind === "match-event")
      .map((event) => [event.eventId, event]),
  );
  const completed: CompleteLifecycle[] = [];
  let suspended: DecisionReceipt | null = null;
  let repriced: DecisionReceipt | null = null;
  let lifecycleReceipts: DecisionReceipt[] = [];

  for (const receipt of receipts) {
    if (receipt.body.action === "SUSPEND") {
      if (!suspended) {
        suspended = receipt;
        lifecycleReceipts = [receipt];
      } else {
        lifecycleReceipts.push(receipt);
      }
      repriced = null;
      continue;
    }
    if (receipt.body.action === "REPRICE" && suspended) {
      repriced = receipt;
      lifecycleReceipts.push(receipt);
      continue;
    }
    if (receipt.body.action === "INVALIDATE_REPRICE" && suspended) {
      repriced = null;
      lifecycleReceipts.push(receipt);
      continue;
    }
    if (receipt.body.action !== "REOPEN" || !suspended || !repriced) continue;
    lifecycleReceipts.push(receipt);

    const sourceEventId =
      suspended.body.sourceIds.find((sourceId) => eventInputs.has(sourceId)) ??
      null;
    const event = sourceEventId ? eventInputs.get(sourceEventId) : undefined;
    const preTriggerQuote = [...quoteInputs]
      .reverse()
      .find((quote) => quote.receivedTs < suspended!.body.observedTs);
    const probabilityMove =
      preTriggerQuote && repriced.body.quote
        ? maximumProbabilityMove(
            preTriggerQuote.probabilities,
            repriced.body.quote,
          )
        : null;
    completed.push({
      trigger: suspended.body.trigger,
      eventType: event?.eventType ?? null,
      sourceEventId,
      suspendTs: suspended.body.observedTs,
      repriceTs: repriced.body.observedTs,
      reopenTs: receipt.body.observedTs,
      suspensionMs: receipt.body.observedTs - suspended.body.observedTs,
      repriceToReopenMs: receipt.body.observedTs - repriced.body.observedTs,
      maximumProbabilityMove: probabilityMove,
      suspendHash: suspended.hash,
      repriceHash: repriced.hash,
      reopenHash: receipt.hash,
      decisionHashes: lifecycleReceipts.map((decision) => decision.hash),
      preResolutionRepricesInvalidated: lifecycleReceipts.filter(
        (decision) => decision.body.action === "INVALIDATE_REPRICE",
      ).length,
    });
    suspended = null;
    repriced = null;
    lifecycleReceipts = [];
  }

  return completed;
}
