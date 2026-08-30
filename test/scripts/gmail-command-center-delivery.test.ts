import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommandCenterMailDeliveryHandler,
  parseCommandCenterMailDeliveryArgs,
  readSecureSecret,
  runCommandCenterMailDelivery,
} from "../../scripts/gmail-command-center-delivery.js";
import {
  buildGogMessageIdReceiptArgs,
  CommandCenterMailDeliveryError,
  deliverCommandCenterMailWatchPayload,
  parseGogMessageIdReceipt,
  resolveCommandCenterMailIngestUrl,
} from "../../scripts/lib/gmail-command-center-delivery.js";

const mailbox = "watcher@example.test";
const commandCenterBaseUrl = "https://command-center.example.test";
const commandCenterBearer = "synthetic-command-center-bearer";
const hookBearer = "synthetic-local-hook-bearer";
const tempDirs: string[] = [];

function watchMessage(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    threadId: `thread-${id}`,
    from: '"Synthetic Sender" <sender@example.test>',
    to: "untrusted@example.test",
    subject: `Synthetic subject ${id}`,
    date: "2026-08-30T12:00:00.000Z",
    snippet: "Synthetic snippet",
    body: `Synthetic body ${id}`,
    bodyTruncated: false,
    labels: ["INBOX"],
    ...overrides,
  };
}

function watchPayload(messages: unknown[] = [watchMessage("message-1")]) {
  return {
    source: "gmail",
    account: mailbox,
    historyId: "123456",
    deletedMessageIds: [],
    messages,
  };
}

function metadataOutput(messageId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    message: {
      id: messageId,
      threadId: `thread-${messageId}`,
      labelIds: ["INBOX"],
      payload: {
        headers: [{ name: "Message-ID", value: `<${messageId}@example.test>` }],
      },
      ...overrides,
    },
    headers: { message_id: `<${messageId}@example.test>` },
  });
}

function requestMessageId(args: readonly string[]): string {
  const getIndex = args.indexOf("get");
  const messageId = args[getIndex + 1];
  if (!messageId) {
    throw new Error("missing synthetic message id");
  }
  return messageId;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type CapturedResponse = {
  status?: number;
  body: string;
  response: ServerResponse;
};

function fakeRequest(params: {
  body: unknown;
  bearer?: string;
  contentType?: string;
}): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(params.body))]) as IncomingMessage;
  request.method = "POST";
  request.url = "/gmail-command-center";
  request.headers = {
    authorization: params.bearer ? `Bearer ${params.bearer}` : undefined,
    "content-type": params.contentType ?? "application/json",
  };
  return request;
}

function fakeResponse(): CapturedResponse {
  const captured: CapturedResponse = {
    body: "",
    response: undefined as unknown as ServerResponse,
  };
  captured.response = {
    destroyed: false,
    writableEnded: false,
    once() {
      return this;
    },
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(chunk?: string) {
      captured.body += chunk ?? "";
      return this;
    },
  } as unknown as ServerResponse;
  return captured;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Command Center Gmail delivery adapter", () => {
  it("pins gog to one read-only metadata command with no send capability", () => {
    expect(buildGogMessageIdReceiptArgs({ mailbox, messageId: "message-1" })).toEqual([
      "--account",
      mailbox,
      "--enable-commands-exact",
      "gmail.get",
      "--gmail-no-send",
      "--readonly",
      "--no-input",
      "--json",
      "--results-only",
      "gmail",
      "get",
      "message-1",
      "--format",
      "metadata",
      "--headers",
      "Message-ID",
    ]);
  });

  it("requires exact provider message, thread, and single raw Message-ID identities", () => {
    expect(
      parseGogMessageIdReceipt({
        stdout: metadataOutput("message-1"),
        expected: { messageId: "message-1", providerThreadId: "thread-message-1" },
      }),
    ).toEqual({ id: "message-1", rfcMessageId: "<message-1@example.test>" });

    expect(() =>
      parseGogMessageIdReceipt({
        stdout: metadataOutput("message-1", { threadId: "wrong-thread" }),
        expected: { messageId: "message-1", providerThreadId: "thread-message-1" },
      }),
    ).toThrowError(expect.objectContaining({ code: "provider_identity_mismatch" }));

    expect(() =>
      parseGogMessageIdReceipt({
        stdout: metadataOutput("message-1", {
          payload: {
            headers: [
              { name: "Message-ID", value: "<message-1@example.test>" },
              { name: "message-id", value: "<hidden@example.test>" },
            ],
          },
        }),
        expected: { messageId: "message-1", providerThreadId: "thread-message-1" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_provider_receipt" }));
  });

  it("reads every metadata receipt before sequential fresh and duplicate delivery", async () => {
    const events: string[] = [];
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const result = await deliverCommandCenterMailWatchPayload({
      watchPayload: watchPayload([watchMessage("message-1"), watchMessage("message-2")]),
      mailbox,
      commandCenterBaseUrl,
      commandCenterBearer,
      runGog: async (args) => {
        const id = requestMessageId(args);
        events.push(`metadata:${id}`);
        return metadataOutput(id);
      },
      fetchImpl: async (input, init) => {
        activeFetches += 1;
        maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
        const body = JSON.parse(String(init?.body)) as { messageId: string };
        events.push(`post:${body.messageId}`);
        requests.push({ url: String(input), init });
        await Promise.resolve();
        activeFetches -= 1;
        return body.messageId === "message-1"
          ? jsonResponse(201, { id: "synthetic-row-1" })
          : jsonResponse(200, { id: "synthetic-row-2", duplicate: true });
      },
    });

    expect(events).toEqual([
      "metadata:message-1",
      "metadata:message-2",
      "post:message-1",
      "post:message-2",
    ]);
    expect(maxActiveFetches).toBe(1);
    expect(requests.map((request) => request.url)).toEqual([
      `${commandCenterBaseUrl}/api/mail/messages`,
      `${commandCenterBaseUrl}/api/mail/messages`,
    ]);
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${commandCenterBearer}`,
        "content-type": "application/json",
      },
    });
    expect(result).toMatchObject({
      contract: "cg-command-center-mail-ingest-delivery-v1",
      mode: "apply",
      ok: true,
      counts: {
        providerMetadataReads: 2,
        deliveryAttempts: 2,
        createdMessages: 1,
        reusedMessages: 1,
      },
    });
    expect(JSON.stringify(result)).not.toContain("message-1");
    expect(JSON.stringify(result)).not.toContain("Synthetic body");
  });

  it("does no Command Center work when any metadata receipt fails", async () => {
    const fetchImpl = vi.fn();
    await expect(
      deliverCommandCenterMailWatchPayload({
        watchPayload: watchPayload([watchMessage("message-1"), watchMessage("message-2")]),
        mailbox,
        commandCenterBaseUrl,
        commandCenterBearer,
        runGog: async (args) => {
          const id = requestMessageId(args);
          if (id === "message-2") {
            throw new Error("synthetic provider failure with private text");
          }
          return metadataOutput(id);
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "provider_receipt_failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops on the first Command Center failure and never exposes its body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, { id: "synthetic-row-1" }))
      .mockResolvedValueOnce(new Response("private downstream failure body", { status: 503 }));
    await expect(
      deliverCommandCenterMailWatchPayload({
        watchPayload: watchPayload([
          watchMessage("message-1"),
          watchMessage("message-2"),
          watchMessage("message-3"),
        ]),
        mailbox,
        commandCenterBaseUrl,
        commandCenterBearer,
        runGog: async (args) => metadataOutput(requestMessageId(args)),
        fetchImpl,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CommandCenterMailDeliveryError>>({
        code: "command_center_http",
        message: "Command Center ingest returned HTTP 503",
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("requires the documented fresh and reuse response shapes", async () => {
    await expect(
      deliverCommandCenterMailWatchPayload({
        watchPayload: watchPayload(),
        mailbox,
        commandCenterBaseUrl,
        commandCenterBearer,
        runGog: async () => metadataOutput("message-1"),
        fetchImpl: async () => jsonResponse(200, { id: "synthetic-row", duplicate: false }),
      }),
    ).rejects.toMatchObject({ code: "invalid_command_center_response" });
  });

  it("accepts only an HTTPS Command Center origin", () => {
    expect(resolveCommandCenterMailIngestUrl(`${commandCenterBaseUrl}/`).toString()).toBe(
      `${commandCenterBaseUrl}/api/mail/messages`,
    );
    for (const invalid of [
      "http://command-center.example.test",
      "https://user:secret@command-center.example.test",
      "https://command-center.example.test/base",
      "https://command-center.example.test/?query=1",
    ]) {
      expect(() => resolveCommandCenterMailIngestUrl(invalid)).toThrowError(
        expect.objectContaining({ code: "invalid_command_center_url" }),
      );
    }
  });

  it("is an offline dry run unless both live flags are present", async () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    await runCommandCenterMailDelivery([
      "--mailbox",
      mailbox,
      "--command-center-url",
      commandCenterBaseUrl,
      "--command-center-token-file",
      "/does/not/exist/command-center",
      "--hook-token-file",
      "/does/not/exist/hook",
    ]);
    expect(stdout.join("")).toContain('"secretFilesRead": 0');
    expect(stdout.join("")).toContain('"networkRequests": 0');

    expect(() =>
      parseCommandCenterMailDeliveryArgs([
        "--mailbox",
        mailbox,
        "--command-center-url",
        commandCenterBaseUrl,
        "--command-center-token-file",
        "cc.token",
        "--hook-token-file",
        "hook.token",
        "--apply",
      ]),
    ).toThrowError(expect.objectContaining({ code: "apply_confirmation_required" }));

    expect(
      parseCommandCenterMailDeliveryArgs([
        "--mailbox",
        mailbox,
        "--command-center-url",
        commandCenterBaseUrl,
        "--command-center-token-file",
        "cc.token",
        "--hook-token-file",
        "hook.token",
        "--apply",
        "--confirm-live-delivery",
      ]),
    ).toMatchObject({ apply: true, confirmLiveDelivery: true });
  });

  it.runIf(process.platform !== "win32")(
    "requires a non-linked, current-owner mode-0600 secret file",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-delivery-secret-"));
      tempDirs.push(dir);
      const secretPath = path.join(dir, "secret");
      fs.writeFileSync(secretPath, `${commandCenterBearer}\n`, { mode: 0o600 });
      expect(readSecureSecret(secretPath, "synthetic bearer").value).toBe(commandCenterBearer);

      fs.chmodSync(secretPath, 0o644);
      expect(() => readSecureSecret(secretPath, "synthetic bearer")).toThrowError(
        expect.objectContaining({ code: "invalid_secret_permissions" }),
      );

      fs.chmodSync(secretPath, 0o600);
      const symlinkPath = path.join(dir, "secret-link");
      fs.symlinkSync(secretPath, symlinkPath);
      expect(() => readSecureSecret(symlinkPath, "synthetic bearer")).toThrowError(
        expect.objectContaining({ code: "invalid_secret_file" }),
      );
      const hardlinkPath = path.join(dir, "secret-hardlink");
      fs.linkSync(secretPath, hardlinkPath);
      expect(() => readSecureSecret(hardlinkPath, "synthetic bearer")).toThrowError(
        expect.objectContaining({ code: "invalid_secret_file" }),
      );
    },
  );

  it("rejects an invalid hook payload before provider or Command Center access", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGog = vi.fn();
    const fetchImpl = vi.fn();
    const handler = createCommandCenterMailDeliveryHandler({
      mailbox,
      commandCenterBaseUrl,
      commandCenterBearer,
      hookBearer,
      runGog,
      fetchImpl,
    });
    const captured = fakeResponse();
    await handler(
      fakeRequest({
        body: { ...watchPayload(), source: "not-gmail" },
        bearer: hookBearer,
      }),
      captured.response,
    );

    expect(captured.status).toBe(503);
    expect(captured.body).toContain('"code":"invalid_source"');
    expect(runGog).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("authenticates the loopback hook and emits only safe failure metadata", async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const handler = createCommandCenterMailDeliveryHandler({
      mailbox,
      commandCenterBaseUrl,
      commandCenterBearer,
      hookBearer,
      runGog: async () => {
        throw new Error("provider-message-private-value");
      },
      fetchImpl: vi.fn(),
    });

    const unauthorized = fakeResponse();
    await handler(fakeRequest({ body: watchPayload() }), unauthorized.response);
    expect(unauthorized.status).toBe(401);

    const failed = fakeResponse();
    await handler(fakeRequest({ body: watchPayload(), bearer: hookBearer }), failed.response);
    expect(failed.status).toBe(503);
    expect(failed.body).toContain('"code":"provider_receipt_failed"');
    expect(failed.body).not.toContain("provider-message-private-value");
    expect(failed.body).not.toContain("Synthetic body");
    expect(stderr.join("")).not.toContain("provider-message-private-value");
  });

  it("answers an identical completed notification from a count-only digest cache", async () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const runGog = vi.fn(async () => metadataOutput("message-1"));
    const fetchImpl = vi.fn(async () => jsonResponse(201, { id: "synthetic-row" }));
    const handler = createCommandCenterMailDeliveryHandler({
      mailbox,
      commandCenterBaseUrl,
      commandCenterBearer,
      hookBearer,
      runGog,
      fetchImpl,
    });

    const first = fakeResponse();
    await handler(fakeRequest({ body: watchPayload(), bearer: hookBearer }), first.response);
    const replay = fakeResponse();
    await handler(fakeRequest({ body: watchPayload(), bearer: hookBearer }), replay.response);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(runGog).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(replay.body)).toMatchObject({
      counts: {
        providerMetadataReads: 0,
        deliveryAttempts: 0,
        createdMessages: 0,
        reusedMessages: 0,
        replayedNotifications: 1,
      },
    });
    expect(stdout.join("")).not.toContain("message-1");
    expect(stdout.join("")).not.toContain("Synthetic body");
  });
});
