import { loadLatestPublicClaim } from "../src/evidence/public-claim.js";
import { loadPublicLiveDecisionTape } from "../src/evidence/live-decision-tape.js";

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
      const [publicClaim, liveDecisionTape] = await Promise.all([
        loadLatestPublicClaim(
          "data/public",
          queryHash ? `0x${queryHash}` : undefined,
        ),
        loadPublicLiveDecisionTape("data/public"),
      ]);

      if (!publicClaim && !liveDecisionTape) {
        return Response.json(
          { error: "Judge evidence bundle not available" },
          { status: 404 },
        );
      }

      return Response.json(
        {
          version: 1,
          status: "AVAILABLE",
          network: "solana-mainnet",
          generatedAt: new Date().toISOString(),
          dataBoundary:
            "Judge evidence is restricted to public, synthetic checkpoints and derived enforcement artifacts; no raw feed vectors, source ids, source timestamps, API tokens, wallet keys, or venue credentials are included.",
          publicClaim: publicClaim
            ? {
                available: true,
                payload: publicClaim,
              }
            : {
                available: false,
                reason: queryHash
                  ? `No approved public claim found for 0x${queryHash}`
                  : "No approved public claim is available",
              },
          liveDecisionTape: liveDecisionTape
            ? {
                available: true,
                payload: liveDecisionTape,
              }
            : {
                available: false,
                reason: "No approved live decision tape is available",
              },
        },
        {
          headers: {
            "Cache-Control": "public, max-age=30, s-maxage=120",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    } catch {
      return Response.json(
        { error: "Judge evidence bundle not available" },
        { status: 404 },
      );
    }
  },
};
