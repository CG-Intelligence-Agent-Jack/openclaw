import { describe, expect, it } from "vitest";
import {
  isBotMentionedFromTargets,
  resolveMentionTargets,
  type MentionConfig,
} from "./mentions.js";
import type { WebInboundMsg } from "./types.js";

const makeMsg = (overrides: Partial<WebInboundMsg>): WebInboundMsg =>
  ({
    id: "m1",
    from: "120363401234567890@g.us",
    conversationId: "120363401234567890@g.us",
    to: "15551234567@s.whatsapp.net",
    accountId: "default",
    body: "",
    chatType: "group",
    chatId: "120363401234567890@g.us",
    sendComposing: async () => {},
    reply: async () => {},
    sendMedia: async () => {},
    ...overrides,
  }) as WebInboundMsg;

function wasMentioned(msg: WebInboundMsg, cfg: MentionConfig): boolean {
  return isBotMentionedFromTargets(msg, cfg, resolveMentionTargets(msg));
}

describe("WhatsApp auto-reply mention detection", () => {
  it("matches LID self mentions before self-chat allowFrom fallback", () => {
    const msg = makeMsg({
      body: "@owner ping",
      mentionedJids: ["12345@lid"],
      selfE164: "+15551234567",
      selfLid: "12345@lid",
    });

    expect(
      wasMentioned(msg, {
        mentionRegexes: [/\bopenclaw\b/i],
        allowFrom: ["+15551234567"],
      }),
    ).toBe(true);
  });

  it("matches E.164-normalized self mentions before explicit self-chat override fallback", () => {
    const msg = makeMsg({
      body: "@owner ping",
      mentionedJids: ["15551234567@s.whatsapp.net"],
      selfE164: "+1 (555) 123-4567",
    });

    expect(
      wasMentioned(msg, {
        mentionRegexes: [],
        isSelfChat: true,
      }),
    ).toBe(true);
  });

  it("still treats null extracted mention arrays as no explicit mentions", () => {
    const msg = makeMsg({
      body: "openclaw ping",
      mentions: null,
      mentionedJids: null,
      selfE164: "+15551234567",
    } as never);

    expect(wasMentioned(msg, { mentionRegexes: [/\bopenclaw\b/i] })).toBe(true);
  });
});
