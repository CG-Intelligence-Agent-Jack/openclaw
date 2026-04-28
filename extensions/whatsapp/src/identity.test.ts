import { describe, expect, it } from "vitest";
import { getMentionIdentities, identitiesOverlap, resolveComparableIdentity } from "./identity.js";

describe("WhatsApp identity normalization", () => {
  it("compares bot selfLid with LID mentions", () => {
    expect(identitiesOverlap({ lid: "12345@lid" }, { jid: "12345@lid" })).toBe(true);
  });

  it("normalizes E.164 values before comparing identities", () => {
    const self = resolveComparableIdentity({ e164: " +1 (555) 123-4567 " });
    const mention = resolveComparableIdentity({ jid: "15551234567@s.whatsapp.net" });

    expect(identitiesOverlap(self, mention)).toBe(true);
  });

  it("treats null mention arrays as no extracted mentions", () => {
    const identities = getMentionIdentities({
      mentions: null,
      mentionedJids: null,
    } as never);

    expect(identities).toEqual([]);
  });
});
