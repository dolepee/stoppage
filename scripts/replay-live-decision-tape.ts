import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { QuoteGovernor } from "../src/domain/governor.js";
import type { GovernorInput } from "../src/domain/types.js";
import { LiveExecutionContextTracker } from "../src/execution-gate/live-context.js";
import { loadPermitSigner } from "../src/execution-gate/permit-v2.js";
import {
  createLiveTapeVenueReceipt,
  LIVE_DECISION_TAPE_PRIVATE_FILE,
  LIVE_DECISION_TAPE_VENUE_ACTIONS_FILE,
  LiveDecisionTapeRecorder,
} from "../src/live/live-decision-tape.js";
import {
  appendPrivateCapture,
  writePrivateCapture,
} from "../src/private/capture-store.js";
import {
  normalize1x2Quote,
  normalizeEventResolution,
  normalizeMatchEvent,
} from "../src/txline/normalize.js";
import {
  oddsPayloadSchema,
  scorePayloadSchema,
  type OddsPayload,
} from "../src/txline/types.js";

interface RawCaptureRecord {
  stream: "odds" | "scores";
  receivedAt: number;
  payload: unknown;
}

const targetPerDecision = readPositiveInteger("--per-decision", 25);
const captures = await capturePaths();
const governor = new QuoteGovernor();
const contexts = new LiveExecutionContextTracker();
let firstRecord = true;
let firstVenueAction = true;
let simulatedVenueCallbacks = 0;
let healthyAllowRecords = 0;
let certifiedReopenRecords = 0;
let blockRecords = 0;
let scannedRecords = 0;
let normalizedInputs = 0;

const recorder = new LiveDecisionTapeRecorder({
  signer: loadPermitSigner({ ...process.env, NODE_ENV: "production" }),
  source: "TXLINE_CAPTURE_REPLAY",
  appendRecord: async (record) => {
    if (firstRecord) {
      firstRecord = false;
      return writePrivateCapture(LIVE_DECISION_TAPE_PRIVATE_FILE, record);
    }
    return appendPrivateCapture(LIVE_DECISION_TAPE_PRIVATE_FILE, record);
  },
  writeStatus: async () => undefined,
  invokeAgentA: async (action) => {
    if (firstVenueAction) {
      firstVenueAction = false;
      await writePrivateCapture(LIVE_DECISION_TAPE_VENUE_ACTIONS_FILE, action);
    } else {
      await appendPrivateCapture(LIVE_DECISION_TAPE_VENUE_ACTIONS_FILE, action);
    }
    simulatedVenueCallbacks += 1;
    return createLiveTapeVenueReceipt(action);
  },
  invokeAgentB: async () => {
    throw new Error("The adversary venue callback must remain closed");
  },
});

captureLoop: for (const path of captures) {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    scannedRecords += 1;
    const raw = parseRawRecord(line, path, scannedRecords);
    const inputs = normalizeRawRecord(raw);
    for (const input of inputs) {
      normalizedInputs += 1;
      const sourceObservedAt = inputTime(input);
      const tick: GovernorInput = {
        kind: "tick",
        observedTs: sourceObservedAt,
      };
      governor.process(tick);
      contexts.observe(tick, new Date(sourceObservedAt).toISOString());
      governor.process(input);
      contexts.observe(input, new Date(sourceObservedAt).toISOString());
      if (input.kind !== "quote") continue;

      const context = contexts
        .contexts(governor)
        .find((candidate) => candidate.state.fixtureId === input.fixtureId);
      if (!context) continue;
      const latestAction = context.state.receipts.at(-1)?.body.action;
      const expectedCertifiedReopen =
        context.state.mode === "OPEN" && latestAction === "REOPEN";
      const expectedBlock = context.state.mode !== "OPEN";
      const healthyTarget = Math.max(0, targetPerDecision - 1);
      const shouldRecord = expectedBlock
        ? blockRecords < targetPerDecision
        : expectedCertifiedReopen
          ? certifiedReopenRecords < 1
          : healthyAllowRecords < healthyTarget;
      if (!shouldRecord) continue;

      const record = await recorder.record(
        context,
        Date.now(),
        input.receivedTs,
      );
      if (record.agentA.gateDecision.startsWith("BLOCK_")) {
        blockRecords += 1;
      } else if (record.agentA.gateDecision === "ALLOW_CERTIFIED_REOPEN") {
        certifiedReopenRecords += 1;
      } else if (record.agentA.gateDecision === "ALLOW_HEALTHY_QUOTE") {
        healthyAllowRecords += 1;
      }
      if (
        healthyAllowRecords + certifiedReopenRecords >= targetPerDecision &&
        certifiedReopenRecords >= 1 &&
        blockRecords >= targetPerDecision
      ) {
        lines.close();
        break captureLoop;
      }
    }
  }
}

if (certifiedReopenRecords < 1 || blockRecords < 1 || firstRecord) {
  throw new Error(
    "Recorded TxLINE captures did not contain both a signed Certified Reopen and blocked quote request",
  );
}
if (
  simulatedVenueCallbacks !== healthyAllowRecords + certifiedReopenRecords ||
  firstVenueAction
) {
  throw new Error(
    "Every allowed request must produce one durable simulated venue action",
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      dataMode: "TXLINE_PRIVATE_CAPTURE_REPLAY",
      capturesScanned: captures.length,
      scannedRecords,
      normalizedInputs,
      selectedRequests:
        healthyAllowRecords + certifiedReopenRecords + blockRecords,
      healthyAllowRecords,
      certifiedReopenRecords,
      blockRecords,
      simulatedVenueCallbacks,
      privateTape: resolve(
        process.env.STOPPAGE_PRIVATE_ROOT ?? "data/private",
        LIVE_DECISION_TAPE_PRIVATE_FILE,
      ),
      privateVenueActions: resolve(
        process.env.STOPPAGE_PRIVATE_ROOT ?? "data/private",
        LIVE_DECISION_TAPE_VENUE_ACTIONS_FILE,
      ),
      boundary:
        "Raw records remained private; only signed enforcement results were selected.",
    },
    null,
    2,
  ),
);

function normalizeRawRecord(record: RawCaptureRecord): GovernorInput[] {
  if (record.stream === "odds") {
    const parsed = oddsPayloadSchema.safeParse(record.payload);
    if (!parsed.success) return [];
    const participants = inferParticipants(parsed.data);
    const quote = normalize1x2Quote(
      parsed.data,
      participants,
      record.receivedAt,
    );
    return quote ? [quote] : [];
  }
  const parsed = scorePayloadSchema.safeParse(record.payload);
  if (!parsed.success) return [];
  const inputs: GovernorInput[] = [];
  const event = normalizeMatchEvent(parsed.data, record.receivedAt);
  const resolution = normalizeEventResolution(parsed.data, record.receivedAt);
  if (event) inputs.push(event);
  if (resolution) inputs.push(resolution);
  return inputs;
}

function inferParticipants(payload: OddsPayload) {
  const teamNames = (payload.PriceNames ?? []).filter((name) => {
    const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return normalized !== "x" && normalized !== "draw";
  });
  return {
    home: teamNames[0] ?? "home",
    away: teamNames.at(-1) ?? "away",
  };
}

function parseRawRecord(
  line: string,
  path: string,
  lineNumber: number,
): RawCaptureRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Malformed private capture at ${path}:${lineNumber}`);
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("stream" in value) ||
    (value.stream !== "odds" && value.stream !== "scores") ||
    !("receivedAt" in value) ||
    !Number.isInteger(value.receivedAt) ||
    !("payload" in value)
  ) {
    throw new Error(`Invalid private capture record at ${path}:${lineNumber}`);
  }
  return value as RawCaptureRecord;
}

async function capturePaths() {
  const provided = readOptionalString("--capture");
  if (provided) return [resolve(provided)];
  const root = resolve(process.env.STOPPAGE_PRIVATE_ROOT ?? "data/private");
  const names = (await readdir(root))
    .filter((name) => /^live-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort();
  if (names.length === 0) {
    throw new Error("No private TxLINE live captures are available");
  }
  return names.map((name) => resolve(root, name));
}

function inputTime(input: GovernorInput) {
  return "receivedTs" in input ? input.receivedTs : input.observedTs;
}

function readOptionalString(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readPositiveInteger(name: string, fallback: number) {
  const value = readOptionalString(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error(`${name} must be an integer from 1 to 500`);
  }
  return parsed;
}
