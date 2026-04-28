import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { fetchDiscordApplicationId, resolveDiscordPrivilegedIntentsFromFlags } from "./probe.js";
import { jsonResponse } from "./test-http-helpers.js";

describe("resolveDiscordPrivilegedIntentsFromFlags", () => {
  it("reports disabled when no bits set", () => {
    expect(resolveDiscordPrivilegedIntentsFromFlags(0)).toEqual({
      presence: "disabled",
      guildMembers: "disabled",
      messageContent: "disabled",
    });
  });

  it("reports enabled when full intent bits set", () => {
    const flags = (1 << 12) | (1 << 14) | (1 << 18);
    expect(resolveDiscordPrivilegedIntentsFromFlags(flags)).toEqual({
      presence: "enabled",
      guildMembers: "enabled",
      messageContent: "enabled",
    });
  });

  it("reports limited when limited intent bits set", () => {
    const flags = (1 << 13) | (1 << 15) | (1 << 19);
    expect(resolveDiscordPrivilegedIntentsFromFlags(flags)).toEqual({
      presence: "limited",
      guildMembers: "limited",
      messageContent: "limited",
    });
  });

  it("prefers enabled over limited when both set", () => {
    const flags = (1 << 12) | (1 << 13) | (1 << 14) | (1 << 15) | (1 << 18) | (1 << 19);
    expect(resolveDiscordPrivilegedIntentsFromFlags(flags)).toEqual({
      presence: "enabled",
      guildMembers: "enabled",
      messageContent: "enabled",
    });
  });

  it("retries Cloudflare HTML rate limits during application id lookup", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetcher = withFetchPreconnect(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("<html><title>Error 1015</title></html>", {
          status: 429,
          headers: { "content-type": "text/html", "retry-after": "0" },
        });
      }
      return jsonResponse({ id: "app-1" });
    });

    try {
      const result = fetchDiscordApplicationId("test", 1_000, fetcher);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(result).resolves.toBe("app-1");
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
