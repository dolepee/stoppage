import {
  loadPermitSigner,
  loadRetiredPermitVerificationKeys,
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
      const signer = loadPermitSigner();
      const retiredKeys = loadRetiredPermitVerificationKeys();
      return Response.json(publicKeySetFor(signer, retiredKeys), {
        headers: {
          "Cache-Control": "no-store",
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
