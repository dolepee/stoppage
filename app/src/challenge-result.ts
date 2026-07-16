import type { BenchLiteResult } from "@stoppage/sdk";

export interface ChallengeResultDisplay {
  passed: boolean;
  title: "REJECTED AS EXPECTED" | "SECURITY CHECK FAILED";
  detail: string;
}

export function getChallengeResultDisplay(
  result: BenchLiteResult,
): ChallengeResultDisplay {
  const passed =
    result.expected === "REJECT" &&
    result.valid === false &&
    result.decision.startsWith("BLOCK_");

  return {
    passed,
    title: passed ? "REJECTED AS EXPECTED" : "SECURITY CHECK FAILED",
    detail: passed
      ? result.decision.replaceAll("_", " ")
      : `UNSAFE ${result.decision.replaceAll("_", " ")}`,
  };
}
