import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const fallbackPath = resolve(process.cwd(), "data/public/public-claim.json");

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

    const file = await readFile(fallbackPath, "utf8");
    const claim = JSON.parse(file);
    const claimHash = normalizeHash(claim.approvedConfigHash);

    if (queryHash && claimHash !== queryHash) {
      response.statusCode = 404;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          error: "Public claim not found",
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
