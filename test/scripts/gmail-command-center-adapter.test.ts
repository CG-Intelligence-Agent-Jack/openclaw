import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseCommandCenterMailPlanArgs,
  runCommandCenterMailPlan,
} from "../../scripts/gmail-command-center-adapter.js";
import {
  buildCommandCenterMailDryRunPlan,
  CommandCenterMailPlanError,
} from "../../scripts/lib/gmail-command-center-adapter.js";

const mailbox = "watcher@example.test";

function watchMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "provider-message-1",
    threadId: "provider-thread-1",
    from: '"Synthetic Sender" <sender@example.test>',
    to: mailbox,
    subject: "Synthetic subject",
    date: "2026-08-30T12:00:00.000Z",
    snippet: "Synthetic snippet",
    body: "Synthetic body",
    bodyTruncated: false,
    labels: ["INBOX"],
    ...overrides,
  };
}

function watchPayload(messages: unknown[] = [watchMessage()]) {
  return {
    source: "gmail",
    account: mailbox,
    historyId: "123456",
    deletedMessageIds: [],
    messages,
  };
}

function metadataReceipts(
  messages = [{ id: "provider-message-1", rfcMessageId: "<synthetic-1@example.test>" }],
) {
  return { messages };
}

function build(params?: { payload?: unknown; metadata?: unknown; configuredMailbox?: string }) {
  return buildCommandCenterMailDryRunPlan({
    watchPayload: params?.payload ?? watchPayload(),
    metadataReceipts: params?.metadata ?? metadataReceipts(),
    mailbox: params?.configuredMailbox ?? mailbox,
  });
}

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Command Center Gmail dry-run adapter", () => {
  it("maps one synthetic Gmail notification to the exact ingest contract", () => {
    const plan = build({
      payload: watchPayload([watchMessage({ to: "untrusted-destination@example.test" })]),
    });

    expect(plan.requests).toEqual([
      {
        mailbox,
        fromEmail: "sender@example.test",
        fromName: "Synthetic Sender",
        subject: "Synthetic subject",
        body: "Synthetic body",
        snippet: "Synthetic snippet",
        messageId: "provider-message-1",
        rfcMessageId: "<synthetic-1@example.test>",
        providerThreadId: "provider-thread-1",
        receivedAt: "2026-08-30T12:00:00.000Z",
      },
    ]);
    expect(plan.summary).toEqual({
      contract: "cg-command-center-mail-ingest-plan-v1",
      mode: "dry-run",
      ok: true,
      mailbox,
      counts: {
        notifications: 1,
        receivedMessages: 1,
        uniqueMessages: 1,
        duplicateMessages: 0,
        deletedMessages: 0,
        metadataReceipts: 1,
        readyRequests: 1,
      },
      guarantees: {
        networkRequests: 0,
        providerCommands: 0,
        stateWrites: 0,
        outputContainsMessageContent: false,
      },
    });
  });

  it("accepts a bare From address and deduplicates an identical provider message", () => {
    const message = watchMessage({ from: "sender@example.test" });
    const plan = build({ payload: watchPayload([message, { ...message }]) });

    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0]).not.toHaveProperty("fromName");
    expect(plan.summary.counts).toMatchObject({
      receivedMessages: 2,
      uniqueMessages: 1,
      duplicateMessages: 1,
    });
  });

  it("preserves the validated plain-text body bytes", () => {
    const plan = build({
      payload: watchPayload([watchMessage({ body: "  Synthetic body\n" })]),
    });

    expect(plan.requests[0]?.body).toBe("  Synthetic body\n");
  });

  it.each([
    ["account_mismatch", { configuredMailbox: "other@example.test" }],
    ["missing_metadata", { metadata: metadataReceipts([]) }],
    [
      "invalid_metadata",
      { metadata: metadataReceipts([{ id: "provider-message-1", rfcMessageId: "not-bracketed" }]) },
    ],
    ["truncated_body", { payload: watchPayload([watchMessage({ bodyTruncated: true })]) }],
    ["not_inbox", { payload: watchPayload([watchMessage({ labels: ["SENT"] })]) }],
    [
      "invalid_from",
      { payload: watchPayload([watchMessage({ from: "one@example.test, two@example.test" })]) },
    ],
  ])("fails closed with %s", (code, overrides) => {
    expect(() => build(overrides)).toThrowError(
      expect.objectContaining<Partial<CommandCenterMailPlanError>>({ code }),
    );
  });

  it("rejects conflicting duplicate provider messages", () => {
    expect(() =>
      build({
        payload: watchPayload([
          watchMessage(),
          watchMessage({ subject: "Conflicting synthetic subject" }),
        ]),
      }),
    ).toThrowError(expect.objectContaining({ code: "conflicting_duplicate" }));
  });

  it("rejects mutation flags because this phase has no apply mode", () => {
    expect(() => parseCommandCenterMailPlanArgs(["--apply"])).toThrowError(
      expect.objectContaining({ code: "mutation_mode_forbidden" }),
    );
  });

  it("accepts pnpm's leading argument separator", () => {
    expect(
      parseCommandCenterMailPlanArgs([
        "--",
        "--input",
        "watch.json",
        "--metadata",
        "metadata.json",
        "--mailbox",
        mailbox,
      ]),
    ).toEqual({
      inputPath: "watch.json",
      metadataPath: "metadata.json",
      mailbox,
    });
  });

  it("emits only the count summary, never message content or provider identifiers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-command-center-plan-"));
    tempDirs.push(dir);
    const inputPath = path.join(dir, "watch.json");
    const metadataPath = path.join(dir, "metadata.json");
    fs.writeFileSync(inputPath, JSON.stringify(watchPayload()));
    fs.writeFileSync(metadataPath, JSON.stringify(metadataReceipts()));
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    runCommandCenterMailPlan([
      "--input",
      inputPath,
      "--metadata",
      metadataPath,
      "--mailbox",
      mailbox,
    ]);

    const rendered = output.join("");
    expect(rendered).toContain('"readyRequests": 1');
    expect(rendered).not.toContain("Synthetic Sender");
    expect(rendered).not.toContain("Synthetic subject");
    expect(rendered).not.toContain("Synthetic body");
    expect(rendered).not.toContain("provider-message-1");
    expect(rendered).not.toContain("synthetic-1@example.test");
  });

  it("has no provider command or network execution seam", () => {
    const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts");
    const source = [
      fs.readFileSync(path.join(scriptsDir, "gmail-command-center-adapter.ts"), "utf8"),
      fs.readFileSync(path.join(scriptsDir, "lib/gmail-command-center-adapter.ts"), "utf8"),
    ].join("\n");

    expect(source).not.toMatch(/node:(?:child_process|http|https|net|tls)/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\b(?:spawn|execFile|exec|fork)\s*\(/);
  });
});
