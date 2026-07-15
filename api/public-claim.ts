import { loadLatestPublicClaim } from "../src/evidence/public-claim.js";

const normalizeHash = (value?: string | null) =>
  value?.toLowerCase().replace(/^0x/, "") || undefined;

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }

    try {
      const requestUrl = new URL(request.url);
      const queryHash = normalizeHash(
        requestUrl.searchParams.get("approvedConfigHash"),
      );
      const claim = await loadLatestPublicClaim(
        "data/public",
        queryHash ? `0x${queryHash}` : undefined,
      );

      if (!claim) {
        return Response.json(
          { error: "Public claim not available" },
          { status: 404 },
        );
      }

      return Response.json(claim, {
        headers: {
          "Cache-Control": "public, max-age=60, s-maxage=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return Response.json(
        { error: "Public claim not available" },
        { status: 404 },
      );
    }
  },
};
