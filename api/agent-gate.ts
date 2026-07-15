import { ZodError } from "zod";

import { evaluatePublicAgentHandshake } from "../src/execution-gate/public-agent-lab.js";

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }

    try {
      return Response.json(evaluatePublicAgentHandshake(await request.json()), {
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
