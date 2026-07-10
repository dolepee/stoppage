import { describe, expect, it } from "vitest";

import { TxLineClient } from "./client.js";

describe("TxLineClient", () => {
  it("requests historical fixture windows with authorized query parameters", async () => {
    const requested: string[] = [];
    const fetchImplementation: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/auth/guest/start")) {
        return Response.json({ token: "guest" });
      }
      return Response.json([]);
    };
    const client = new TxLineClient({
      origin: "https://txline.example",
      apiToken: "api-token",
      fetchImplementation,
    });

    await client.fetchFixtures({ startEpochDay: 20_630, competitionId: 72 });

    expect(requested.at(-1)).toBe(
      "https://txline.example/api/fixtures/snapshot?startEpochDay=20630&competitionId=72",
    );
  });

  it("decodes historical records returned as SSE despite the JSON contract", async () => {
    const fetchImplementation: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) {
        return Response.json({ token: "guest" });
      }
      return new Response(
        [
          'data: {"FixtureId":77,"GameState":"H1","StartTime":500,"Action":"goal","Id":1,"Ts":1000,"Seq":10}',
          "",
          'data: {"FixtureId":77,"GameState":"H1","StartTime":500,"Action":"var_end","Id":2,"Ts":1100,"Seq":11}',
          "",
        ].join("\n"),
        { headers: { "Content-Type": "application/json" } },
      );
    };
    const client = new TxLineClient({
      origin: "https://txline.example",
      apiToken: "api-token",
      fetchImplementation,
    });

    const scores = await client.fetchHistoricalScores(77);

    expect(scores.map((score) => score.action)).toEqual(["goal", "var_end"]);
    expect(scores[0]).toMatchObject({ FixtureId: 77, fixtureId: 77 });
    expect(scores[0]?.startTime).toBe(500);
  });
});
