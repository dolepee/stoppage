import { loadPublicLiveDecisionTape } from "../src/evidence/live-decision-tape.js";

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    const tape = await loadPublicLiveDecisionTape();
    if (!tape) {
      return Response.json(
        { error: "Live decision tape not available" },
        { status: 404 },
      );
    }
    return Response.json(tape, {
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
};
