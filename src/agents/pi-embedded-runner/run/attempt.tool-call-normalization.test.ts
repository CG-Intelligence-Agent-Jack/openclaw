import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  sanitizeReplayToolCallIdsForStream,
  wrapStreamFnSanitizeMalformedToolCalls,
} from "./attempt.tool-call-normalization.js";

type FakeWrappedStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

function createFakeStream(params: {
  events: unknown[];
  resultMessage: unknown;
}): FakeWrappedStream {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
  };
}

describe("sanitizeReplayToolCallIdsForStream", () => {
  it("drops orphaned tool results after strict id sanitization", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_function_av7cbkigmk7x1",
        toolUseId: "call_function_av7cbkigmk7x1",
        toolName: "read",
        content: [{ type: "text", text: "stale" }],
        isError: false,
      } as never,
    ];

    expect(
      sanitizeReplayToolCallIdsForStream({
        messages,
        mode: "strict",
        repairToolUseResultPairing: true,
      }),
    ).toEqual([]);
  });

  it("keeps matched assistant and tool-result ids aligned", () => {
    const rawId = "call_function_av7cbkigmk7x1";
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: rawId, name: "read", input: { path: "." } }],
      } as never,
      {
        role: "toolResult",
        toolCallId: rawId,
        toolUseId: rawId,
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as never,
    ];

    const out = sanitizeReplayToolCallIdsForStream({
      messages,
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "callfunctionav7cbkigmk7x1", name: "read" }],
      },
      {
        role: "toolResult",
        toolCallId: "callfunctionav7cbkigmk7x1",
        toolUseId: "callfunctionav7cbkigmk7x1",
        toolName: "read",
      },
    ]);
  });

  it("synthesizes missing tool results after strict id sanitization", () => {
    const rawId = "call_function_av7cbkigmk7x1";
    const out = sanitizeReplayToolCallIdsForStream({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolUse", id: rawId, name: "read", input: { path: "." } },
            { type: "toolUse", id: "call_missing", name: "exec", input: { cmd: "true" } },
          ],
        } as never,
        {
          role: "toolResult",
          toolCallId: rawId,
          toolUseId: rawId,
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
        } as never,
      ],
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out.map((message) => message.role)).toEqual(["assistant", "toolResult", "toolResult"]);
    expect((out[0] as Extract<AgentMessage, { role: "assistant" }>).content).toMatchObject([
      { type: "toolUse", id: "callfunctionav7cbkigmk7x1", name: "read" },
      { type: "toolUse", id: "callmissing", name: "exec" },
    ]);
    expect(out[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "callfunctionav7cbkigmk7x1",
      toolUseId: "callfunctionav7cbkigmk7x1",
    });
    expect(out[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "callmissing",
      isError: true,
    });
  });

  it("synthesizes missing tool results when repair is enabled", () => {
    const out = sanitizeReplayToolCallIdsForStream({
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "call_missing", name: "exec", input: { cmd: "true" } }],
        } as never,
      ],
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out).toMatchObject([
      { role: "assistant" },
      { role: "toolResult", toolCallId: "callmissing", isError: true },
    ]);
  });

  it("keeps real tool results for aborted assistant spans", () => {
    const rawId = "call_function_av7cbkigmk7x1";
    const out = sanitizeReplayToolCallIdsForStream({
      messages: [
        {
          role: "assistant",
          stopReason: "aborted",
          content: [{ type: "toolUse", id: rawId, name: "read", input: { path: "." } }],
        } as never,
        {
          role: "toolResult",
          toolCallId: rawId,
          toolUseId: rawId,
          toolName: "read",
          content: [{ type: "text", text: "partial" }],
          isError: false,
        } as never,
        {
          role: "user",
          content: [{ type: "text", text: "retry" }],
        } as never,
      ],
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out).toMatchObject([
      {
        role: "assistant",
        stopReason: "aborted",
        content: [{ type: "toolUse", id: "callfunctionav7cbkigmk7x1", name: "read" }],
      },
      {
        role: "toolResult",
        toolCallId: "callfunctionav7cbkigmk7x1",
        toolUseId: "callfunctionav7cbkigmk7x1",
        toolName: "read",
      },
      {
        role: "user",
      },
    ]);
  });
});

describe("wrapStreamFnSanitizeMalformedToolCalls", () => {
  it("repairs a poisoned outbound replay with dangling tool use, empty blocks, and oversized text", async () => {
    const oversizedText = "x".repeat(20_000);
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolUse", name: "read", input: { path: "." } },
          {},
          { type: "text", text: "" },
        ],
      },
      {
        role: "user",
        content: [
          null,
          {
            type: "toolResult",
            toolUseId: "call_missing",
            content: [{ type: "text", text: "orphaned result" }],
          },
          { type: "text", text: oversizedText },
        ],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateAnthropicTurns: true,
      preserveSignatures: true,
      dropThinkingBlocks: false,
    } as never);
    const stream = wrapped(
      { api: "anthropic-messages" } as never,
      { messages } as never,
      {} as never,
    ) as FakeWrappedStream | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
    };
    expect(seenContext.messages).toHaveLength(1);
    expect(seenContext.messages[0]?.role).toBe("user");
    expect(seenContext.messages[0]?.content).toHaveLength(1);
    const repairedText = seenContext.messages[0]?.content?.[0]?.text ?? "";
    expect(repairedText).toContain("[openclaw] pre-send sanitizer truncated");
    expect(repairedText.length).toBeLessThanOrEqual(16_000);
  });
});
