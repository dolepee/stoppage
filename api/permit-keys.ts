import {
  loadPermitSigner,
  publicKeySetFor,
} from "../src/execution-gate/permit-v2.js";

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }

    try {
      return Response.json(publicKeySetFor(loadPermitSigner()), {
        headers: {
          "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return Response.json(
        { error: "Permit verification keys unavailable" },
        { status: 503 },
      );
    }
  },
};
