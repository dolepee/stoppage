import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { DEFAULT_GOVERNOR_CONFIG } from "../src/domain/governor.js";
import { calibratePolicy } from "../src/evaluation/calibration.js";
import { writePrivateCapture } from "../src/private/capture-store.js";
import {
  buildReplayInputs,
  type PrivateTxLineCapture,
} from "../src/replay/txline-capture.js";

const fixtureId = readIntegerArgument("--fixture");
const capturePath = await findCapturePath(fixtureId);
const capture = JSON.parse(
  await readFile(capturePath, "utf8"),
) as PrivateTxLineCapture;
const { inputs } = buildReplayInputs(capture);
const report = calibratePolicy(inputs, DEFAULT_GOVERNOR_CONFIG);
const output = await writePrivateCapture(
  `calibration-${fixtureId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  {
    version: 1,
    fixtureId,
    sourceCapture: basename(capturePath),
    ...report,
  },
);

console.log(
  JSON.stringify(
    {
      fixtureId,
      ...report,
      privateCalibration: output,
      approvalRequired: true,
      holdoutRunAuthorized: false,
    },
    null,
    2,
  ),
);

async function findCapturePath(id: number) {
  const { readdir } = await import("node:fs/promises");
  const root = resolve("data/private");
  const latest = (await readdir(root))
    .filter(
      (name) => name.startsWith(`fixture-${id}-`) && name.endsWith(".json"),
    )
    .sort()
    .at(-1);
  if (!latest) throw new Error(`No private capture found for fixture ${id}`);
  return resolve(root, latest);
}

function readIntegerArgument(name: string): number {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : Number.NaN;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Usage: pnpm policy:calibrate -- --fixture <positive fixture id>`,
    );
  }
  return value;
}
