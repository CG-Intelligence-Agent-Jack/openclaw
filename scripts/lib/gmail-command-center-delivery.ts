import {
  buildCommandCenterMailDryRunPlan,
  type CommandCenterMailIngestRequest,
  type CommandCenterMailMetadataTarget,
  inspectCommandCenterMailMetadataTargets,
} from "./gmail-command-center-adapter.js";

export const COMMAND_CENTER_MAIL_DELIVERY_CONTRACT = "cg-command-center-mail-ingest-delivery-v1";

const RFC_MESSAGE_ID_RE = /^<[^<>\s@]+@[^<>\s@]+>$/;
const RFC_MESSAGE_ID_MAX_LENGTH = 998;
const MAX_GOG_OUTPUT_BYTES = 1_000_000;
const MAX_COMMAND_CENTER_RESPONSE_BYTES = 32_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

type JsonObject = Record<string, unknown>;

export type CommandCenterMailDeliverySummary = {
  contract: typeof COMMAND_CENTER_MAIL_DELIVERY_CONTRACT;
  mode: "apply";
  ok: true;
  counts: {
    receivedMessages: number;
    uniqueMessages: number;
    duplicateMessages: number;
    deletedMessages: number;
    providerMetadataReads: number;
    deliveryAttempts: number;
    createdMessages: number;
    reusedMessages: number;
    replayedNotifications: 0 | 1;
  };
  guarantees: {
    sequentialDelivery: true;
    outputContainsMessageContent: false;
    stableProviderIdDedupe: true;
  };
};

export type GogCommandRunner = (args: readonly string[]) => Promise<string>;
export type CommandCenterFetch = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

export class CommandCenterMailDeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CommandCenterMailDeliveryError";
  }
}

function fail(code: string, message: string): never {
  throw new CommandCenterMailDeliveryError(code, message);
}

function asObject(value: unknown, code: string, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${label} must be an object`);
  }
  return value as JsonObject;
}

function requiredString(object: JsonObject, key: string, code: string, label: string): string {
  const value = object[key];
  if (typeof value !== "string" || !value.trim()) {
    fail(code, `${label} must be a non-empty string`);
  }
  return value.trim();
}

export function isValidCommandCenterMailBearer(value: string): boolean {
  if (value.length < 16 || value.length > 4096) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      /\s/u.test(character) ||
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    ) {
      return false;
    }
  }
  return true;
}

function assertBearer(value: string): void {
  if (!isValidCommandCenterMailBearer(value)) {
    fail("invalid_bearer", "Command Center bearer is invalid");
  }
}

export function resolveCommandCenterMailIngestUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    fail("invalid_command_center_url", "Command Center URL must be an absolute HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    fail("invalid_command_center_url", "Command Center URL must be an absolute HTTPS origin");
  }
  return new URL("/api/mail/messages", parsed.origin);
}

export function buildGogMessageIdReceiptArgs(params: {
  mailbox: string;
  messageId: string;
}): string[] {
  return [
    "--account",
    params.mailbox,
    "--enable-commands-exact",
    "gmail.get",
    "--gmail-no-send",
    "--readonly",
    "--no-input",
    "--json",
    "--results-only",
    "gmail",
    "get",
    params.messageId,
    "--format",
    "metadata",
    "--headers",
    "Message-ID",
  ];
}

export function parseGogMessageIdReceipt(params: {
  stdout: string;
  expected: CommandCenterMailMetadataTarget;
}): { id: string; rfcMessageId: string } {
  if (!params.stdout || Buffer.byteLength(params.stdout, "utf8") > MAX_GOG_OUTPUT_BYTES) {
    fail("invalid_provider_receipt", "Gmail metadata receipt output is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(params.stdout) as unknown;
  } catch {
    fail("invalid_provider_receipt", "Gmail metadata receipt output is not valid JSON");
  }
  const root = asObject(decoded, "invalid_provider_receipt", "Gmail metadata receipt");
  const message = asObject(
    root.message,
    "invalid_provider_receipt",
    "Gmail metadata receipt message",
  );
  if (
    requiredString(message, "id", "invalid_provider_receipt", "Gmail provider message id") !==
    params.expected.messageId
  ) {
    fail("provider_identity_mismatch", "Gmail metadata receipt message identity changed");
  }
  if (
    requiredString(message, "threadId", "invalid_provider_receipt", "Gmail provider thread id") !==
    params.expected.providerThreadId
  ) {
    fail("provider_identity_mismatch", "Gmail metadata receipt thread identity changed");
  }
  const payload = asObject(
    message.payload,
    "invalid_provider_receipt",
    "Gmail metadata receipt payload",
  );
  if (!Array.isArray(payload.headers) || payload.headers.length > 100) {
    fail("invalid_provider_receipt", "Gmail metadata receipt headers are invalid");
  }
  const messageIdHeaders: string[] = [];
  for (const headerValue of payload.headers) {
    const header = asObject(
      headerValue,
      "invalid_provider_receipt",
      "Gmail metadata receipt header",
    );
    const name = requiredString(
      header,
      "name",
      "invalid_provider_receipt",
      "Gmail metadata receipt header name",
    );
    if (name.toLowerCase() !== "message-id") {
      continue;
    }
    messageIdHeaders.push(
      requiredString(header, "value", "invalid_provider_receipt", "Gmail RFC Message-ID header"),
    );
  }
  if (
    messageIdHeaders.length !== 1 ||
    (messageIdHeaders[0]?.length ?? 0) > RFC_MESSAGE_ID_MAX_LENGTH ||
    !RFC_MESSAGE_ID_RE.test(messageIdHeaders[0] ?? "")
  ) {
    fail(
      "invalid_provider_receipt",
      "Gmail metadata receipt must contain one exact RFC Message-ID header",
    );
  }
  return { id: params.expected.messageId, rfcMessageId: messageIdHeaders[0] };
}

export async function readGogMessageIdReceipt(params: {
  mailbox: string;
  target: CommandCenterMailMetadataTarget;
  runGog: GogCommandRunner;
}): Promise<{ id: string; rfcMessageId: string }> {
  let stdout: string;
  try {
    stdout = await params.runGog(
      buildGogMessageIdReceiptArgs({
        mailbox: params.mailbox,
        messageId: params.target.messageId,
      }),
    );
  } catch {
    fail("provider_receipt_failed", "Gmail metadata receipt command failed");
  }
  return parseGogMessageIdReceipt({ stdout, expected: params.target });
}

async function readBoundedResponseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    fail("invalid_command_center_response", "Command Center response body is missing");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      total += part.value.byteLength;
      if (total > MAX_COMMAND_CENTER_RESPONSE_BYTES) {
        await reader.cancel();
        fail("invalid_command_center_response", "Command Center response body is too large");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof CommandCenterMailDeliveryError) {
      throw error;
    }
    fail("invalid_command_center_response", "Command Center response body could not be read");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        total,
      ).toString(),
    );
  } catch {
    fail("invalid_command_center_response", "Command Center response body is not valid JSON");
  }
  return decoded;
}

async function deliverOneRequest(params: {
  request: CommandCenterMailIngestRequest;
  ingestUrl: URL;
  bearer: string;
  fetchImpl: CommandCenterFetch;
  requestTimeoutMs: number;
}): Promise<"created" | "reused"> {
  let response: Response;
  try {
    response = await params.fetchImpl(params.ingestUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(params.request),
      redirect: "error",
      signal: AbortSignal.timeout(params.requestTimeoutMs),
    });
  } catch {
    fail("command_center_transport", "Command Center ingest request failed");
  }

  if (response.status !== 200 && response.status !== 201) {
    try {
      await response.body?.cancel();
    } catch {
      // The response body is intentionally ignored so provider text cannot enter logs.
    }
    fail("command_center_http", `Command Center ingest returned HTTP ${response.status}`);
  }

  const decoded = asObject(
    await readBoundedResponseJson(response),
    "invalid_command_center_response",
    "Command Center response",
  );
  requiredString(decoded, "id", "invalid_command_center_response", "Command Center response id");
  if (response.status === 201) {
    if (decoded.duplicate !== undefined && decoded.duplicate !== false) {
      fail("invalid_command_center_response", "Command Center fresh response is invalid");
    }
    return "created";
  }
  if (decoded.duplicate !== true) {
    fail("invalid_command_center_response", "Command Center reuse response is invalid");
  }
  return "reused";
}

export async function deliverCommandCenterMailWatchPayload(params: {
  watchPayload: unknown;
  mailbox: string;
  commandCenterBaseUrl: string;
  commandCenterBearer: string;
  runGog: GogCommandRunner;
  fetchImpl?: CommandCenterFetch;
  requestTimeoutMs?: number;
}): Promise<CommandCenterMailDeliverySummary> {
  const targets = inspectCommandCenterMailMetadataTargets({
    watchPayload: params.watchPayload,
    mailbox: params.mailbox,
  });
  const receipts: Array<{ id: string; rfcMessageId: string }> = [];
  for (const target of targets) {
    receipts.push(
      await readGogMessageIdReceipt({ mailbox: params.mailbox, target, runGog: params.runGog }),
    );
  }
  const plan = buildCommandCenterMailDryRunPlan({
    watchPayload: params.watchPayload,
    metadataReceipts: { messages: receipts },
    mailbox: params.mailbox,
  });

  const ingestUrl = resolveCommandCenterMailIngestUrl(params.commandCenterBaseUrl);
  assertBearer(params.commandCenterBearer);
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  const requestTimeoutMs = params.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1_000 ||
    requestTimeoutMs > 60_000
  ) {
    fail("invalid_timeout", "Command Center request timeout is invalid");
  }

  let createdMessages = 0;
  let reusedMessages = 0;
  for (const request of plan.requests) {
    const outcome = await deliverOneRequest({
      request,
      ingestUrl,
      bearer: params.commandCenterBearer,
      fetchImpl,
      requestTimeoutMs,
    });
    if (outcome === "created") {
      createdMessages += 1;
    } else {
      reusedMessages += 1;
    }
  }

  return {
    contract: COMMAND_CENTER_MAIL_DELIVERY_CONTRACT,
    mode: "apply",
    ok: true,
    counts: {
      receivedMessages: plan.summary.counts.receivedMessages,
      uniqueMessages: plan.summary.counts.uniqueMessages,
      duplicateMessages: plan.summary.counts.duplicateMessages,
      deletedMessages: plan.summary.counts.deletedMessages,
      providerMetadataReads: receipts.length,
      deliveryAttempts: plan.requests.length,
      createdMessages,
      reusedMessages,
      replayedNotifications: 0,
    },
    guarantees: {
      sequentialDelivery: true,
      outputContainsMessageContent: false,
      stableProviderIdDedupe: true,
    },
  };
}
