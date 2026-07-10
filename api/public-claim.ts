import { loadLatestPublicClaim } from "../src/evidence/public-claim.js";

const normalizeHash = (value?: string) =>
  value?.toLowerCase().replace(/^0x/, "") || undefined;

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.statusCode = 405;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        error: "Method not allowed",
      }),
    );
    return;
  }

  try {
    const requestUrl = new URL(request.url || "", "http://localhost");
    const queryHash = normalizeHash(
      requestUrl.searchParams.get("approvedConfigHash") ?? undefined,
    );

    const claim = await loadLatestPublicClaim(
      "data/public",
      queryHash ? `0x${queryHash}` : undefined,
    );
    if (!claim) {
      response.statusCode = 404;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          error: "Public claim not available",
        }),
      );
      return;
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(claim));
  } catch (_error) {
    response.statusCode = 404;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        error: "Public claim not available",
      }),
    );
  }
}
