import { describe, expect, it } from "vitest";

import { parseSseBlock, readSseMessages } from "./sse.js";

describe("TxLINE SSE parser", () => {
  it("parses ids, event names, retry, and multi-line data", () => {
    expect(
      parseSseBlock(
        [
          "id: 1000:1",
          "event: odds",
          "retry: 2000",
          'data: {"FixtureId":1,',
          'data: "MessageId":"m1"}',
        ].join("\n"),
      ),
    ).toEqual({
      id: "1000:1",
      event: "odds",
      retry: 2000,
      data: '{"FixtureId":1,\n"MessageId":"m1"}',
    });
  });

  it("handles chunk boundaries without losing messages", async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('event: heartbeat\ndata: {"Ts":1}'),
          );
          controller.enqueue(
            encoder.encode('\n\nid: 2\ndata: {"ok":true}\n\n'),
          );
          controller.close();
        },
      }),
    );
    const messages = [];
    for await (const message of readSseMessages(response))
      messages.push(message);

    expect(messages).toEqual([
      { event: "heartbeat", data: '{"Ts":1}' },
      { id: "2", data: '{"ok":true}' },
    ]);
  });
});
