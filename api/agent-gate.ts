import { ZodError } from "zod";

import { evaluatePublicAgentHandshake } from "../src/execution-gate/public-agent-lab.js";
import { loadPermitSigner } from "../src/execution-gate/permit-v2.js";

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }

    try {
      const body: unknown = await request.json();
      const signer = isPermitV2Request(body) ? loadPermitSigner() : undefined;
      return Response.json(evaluatePublicAgentHandshake(body, signer), {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      if (error instanceof ZodError || error instanceof SyntaxError) {
        return Response.json(
          { error: "Invalid agent request" },
          { status: 400 },
        );
      }
      return Response.json(
        { error: "Agent gate failed closed" },
        { status: 500 },
      );
    }
  },
};

function isPermitV2Request(
  value: unknown,
): value is { version: 2 } & Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    "version" in value &&
    value.version === 2,
  );
}
