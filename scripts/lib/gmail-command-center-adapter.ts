const EMAIL_ADDRESS_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const RFC_MESSAGE_ID_RE = /^<[^<>\s@]+@[^<>\s@]+>$/;
const RFC_MESSAGE_ID_MAX_LENGTH = 998;
const MAX_BATCH_MESSAGES = 500;
const MAX_BODY_LENGTH = 100_000;
const MAX_SUBJECT_LENGTH = 300;
const MAX_SNIPPET_LENGTH = 200;
const MAX_FROM_NAME_LENGTH = 120;

export const COMMAND_CENTER_MAIL_PLAN_CONTRACT = "cg-command-center-mail-ingest-plan-v1";

type JsonObject = Record<string, unknown>;

export type CommandCenterMailIngestRequest = {
  mailbox: string;
  fromEmail: string;
  subject: string;
  body: string;
  messageId: string;
  rfcMessageId: string;
  providerThreadId: string;
  receivedAt: string;
  fromName?: string;
  snippet?: string;
};

export type CommandCenterMailDryRunSummary = {
  contract: typeof COMMAND_CENTER_MAIL_PLAN_CONTRACT;
  mode: "dry-run";
  ok: true;
  mailbox: string;
  counts: {
    notifications: 1;
    receivedMessages: number;
    uniqueMessages: number;
    duplicateMessages: number;
    deletedMessages: number;
    metadataReceipts: number;
    readyRequests: number;
  };
  guarantees: {
    networkRequests: 0;
    providerCommands: 0;
    stateWrites: 0;
    outputContainsMessageContent: false;
  };
};

export type CommandCenterMailDryRunPlan = {
  summary: CommandCenterMailDryRunSummary;
  requests: CommandCenterMailIngestRequest[];
};

export type CommandCenterMailMetadataTarget = {
  messageId: string;
  providerThreadId: string;
};

type ParsedCommandCenterMailIngestRequest = Omit<CommandCenterMailIngestRequest, "rfcMessageId">;

type ParsedCommandCenterMailWatchPayload = {
  mailbox: string;
  receivedMessages: number;
  deletedMessages: number;
  duplicateMessages: number;
  requestsById: Map<string, ParsedCommandCenterMailIngestRequest>;
};

export class CommandCenterMailPlanError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CommandCenterMailPlanError";
  }
}

function fail(code: string, message: string): never {
  throw new CommandCenterMailPlanError(code, message);
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

function optionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeMailbox(raw: string, label: string): string {
  const mailbox = raw.trim().toLowerCase();
  if (mailbox.length > 200 || !EMAIL_ADDRESS_RE.test(mailbox)) {
    fail("invalid_mailbox", `${label} must be one normalized email address`);
  }
  return mailbox;
}

export function normalizeCommandCenterMailConfiguredMailbox(raw: string): string {
  return normalizeMailbox(raw, "configured mailbox");
}

function parseFromHeader(raw: string, index: number): { fromEmail: string; fromName?: string } {
  const value = raw.trim();
  if (EMAIL_ADDRESS_RE.test(value.toLowerCase())) {
    return { fromEmail: value.toLowerCase() };
  }

  const match = value.match(/^(.+?)\s*<([^<>]+)>$/);
  if (!match) {
    fail("invalid_from", `message ${index} From header must contain exactly one email address`);
  }
  const fromEmail = normalizeMailbox(match[2] ?? "", `message ${index} From header`);
  let fromName = (match[1] ?? "").trim();
  if (fromName.startsWith('"') && fromName.endsWith('"') && fromName.length >= 2) {
    fromName = fromName
      .slice(1, -1)
      .replace(/\\(["\\])/g, "$1")
      .trim();
  }
  if (!fromName || fromName.length > MAX_FROM_NAME_LENGTH || /[\r\n]/.test(fromName)) {
    fail("invalid_from_name", `message ${index} From display name is invalid`);
  }
  return { fromEmail, fromName };
}

function parseMetadataReceipts(value: unknown): Map<string, string> {
  const root = asObject(value, "invalid_metadata", "metadata receipt document");
  if (!Array.isArray(root.messages) || root.messages.length > MAX_BATCH_MESSAGES) {
    fail(
      "invalid_metadata",
      `metadata receipt document messages must be an array of at most ${MAX_BATCH_MESSAGES}`,
    );
  }

  const receipts = new Map<string, string>();
  for (const [index, item] of root.messages.entries()) {
    const receipt = asObject(item, "invalid_metadata", `metadata receipt ${index}`);
    const id = requiredString(receipt, "id", "invalid_metadata", `metadata receipt ${index} id`);
    if (!PROVIDER_ID_RE.test(id)) {
      fail("invalid_metadata", `metadata receipt ${index} id is invalid`);
    }
    const rfcMessageId = requiredString(
      receipt,
      "rfcMessageId",
      "invalid_metadata",
      `metadata receipt ${index} RFC Message-ID`,
    );
    if (rfcMessageId.length > RFC_MESSAGE_ID_MAX_LENGTH || !RFC_MESSAGE_ID_RE.test(rfcMessageId)) {
      fail("invalid_metadata", `metadata receipt ${index} RFC Message-ID is invalid`);
    }
    if (receipts.has(id)) {
      fail("duplicate_metadata", `metadata receipt ${index} repeats a provider message id`);
    }
    receipts.set(id, rfcMessageId);
  }
  return receipts;
}

function parseDeletedMessageCount(root: JsonObject): number {
  if (root.deletedMessageIds === undefined) {
    return 0;
  }
  if (
    !Array.isArray(root.deletedMessageIds) ||
    root.deletedMessageIds.length > MAX_BATCH_MESSAGES
  ) {
    fail(
      "invalid_deleted_messages",
      `deletedMessageIds must be an array of at most ${MAX_BATCH_MESSAGES}`,
    );
  }
  for (const [index, value] of root.deletedMessageIds.entries()) {
    if (typeof value !== "string" || !PROVIDER_ID_RE.test(value)) {
      fail("invalid_deleted_messages", `deleted message ${index} id is invalid`);
    }
  }
  return root.deletedMessageIds.length;
}

function parseMessage(params: {
  value: unknown;
  index: number;
  mailbox: string;
}): ParsedCommandCenterMailIngestRequest {
  const { index, mailbox } = params;
  const message = asObject(params.value, "invalid_message", `message ${index}`);
  const id = requiredString(message, "id", "invalid_message", `message ${index} id`);
  if (!PROVIDER_ID_RE.test(id) || id.length > 200) {
    fail("invalid_message", `message ${index} id is invalid`);
  }
  const threadId = requiredString(
    message,
    "threadId",
    "invalid_message",
    `message ${index} threadId`,
  );
  if (!PROVIDER_ID_RE.test(threadId)) {
    fail("invalid_message", `message ${index} threadId is invalid`);
  }
  const labels = message.labels;
  if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string")) {
    fail("invalid_message", `message ${index} labels must be a string array`);
  }
  if (!labels.includes("INBOX")) {
    fail("not_inbox", `message ${index} is not labeled INBOX`);
  }
  if (message.bodyTruncated === true) {
    fail("truncated_body", `message ${index} body is truncated`);
  }
  if (message.bodyTruncated !== undefined && message.bodyTruncated !== false) {
    fail("invalid_message", `message ${index} bodyTruncated must be boolean`);
  }

  const bodyValue = message.body;
  if (typeof bodyValue !== "string" || !bodyValue.trim()) {
    fail("invalid_message", `message ${index} body must be a non-empty string`);
  }
  const body = bodyValue;
  if (body.length > MAX_BODY_LENGTH) {
    fail("body_too_large", `message ${index} body exceeds the Command Center limit`);
  }
  const subject = requiredString(message, "subject", "invalid_message", `message ${index} subject`);
  if (subject.length > MAX_SUBJECT_LENGTH || /[\r\n]/.test(subject)) {
    fail("invalid_subject", `message ${index} subject is invalid`);
  }
  const from = requiredString(message, "from", "invalid_message", `message ${index} From`);
  const fromIdentity = parseFromHeader(from, index);
  const date = requiredString(message, "date", "invalid_message", `message ${index} date`);
  const receivedAt = new Date(date);
  if (Number.isNaN(receivedAt.getTime())) {
    fail("invalid_date", `message ${index} date is invalid`);
  }
  const snippet = optionalString(message, "snippet");
  if (snippet && /[\r\n]/.test(snippet)) {
    fail("invalid_snippet", `message ${index} snippet is invalid`);
  }

  return {
    mailbox,
    ...fromIdentity,
    subject,
    body,
    ...(snippet ? { snippet: snippet.slice(0, MAX_SNIPPET_LENGTH) } : {}),
    messageId: id,
    providerThreadId: threadId,
    receivedAt: receivedAt.toISOString(),
  };
}

function requestsEqual(
  left: ParsedCommandCenterMailIngestRequest,
  right: ParsedCommandCenterMailIngestRequest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseWatchPayload(params: {
  watchPayload: unknown;
  mailbox: string;
}): ParsedCommandCenterMailWatchPayload {
  const mailbox = normalizeCommandCenterMailConfiguredMailbox(params.mailbox);
  const root = asObject(params.watchPayload, "invalid_payload", "watch payload");
  if (root.source !== "gmail") {
    fail("invalid_source", "watch payload source must be gmail");
  }
  const account = normalizeMailbox(
    requiredString(root, "account", "invalid_account", "watch payload account"),
    "watch payload account",
  );
  if (account !== mailbox) {
    fail("account_mismatch", "watch payload account does not match the configured mailbox");
  }
  const historyId = requiredString(root, "historyId", "invalid_history", "watch payload historyId");
  if (!/^\d{1,64}$/.test(historyId)) {
    fail("invalid_history", "watch payload historyId is invalid");
  }
  if (!Array.isArray(root.messages) || root.messages.length > MAX_BATCH_MESSAGES) {
    fail(
      "invalid_messages",
      `watch payload messages must be an array of at most ${MAX_BATCH_MESSAGES}`,
    );
  }

  const deletedMessages = parseDeletedMessageCount(root);
  const requestsById = new Map<string, ParsedCommandCenterMailIngestRequest>();
  let duplicateMessages = 0;
  for (const [index, value] of root.messages.entries()) {
    const request = parseMessage({ value, index, mailbox });
    const existing = requestsById.get(request.messageId);
    if (existing) {
      if (!requestsEqual(existing, request)) {
        fail("conflicting_duplicate", `message ${index} conflicts with an earlier provider id`);
      }
      duplicateMessages += 1;
      continue;
    }
    requestsById.set(request.messageId, request);
  }

  return {
    mailbox,
    receivedMessages: root.messages.length,
    deletedMessages,
    duplicateMessages,
    requestsById,
  };
}

export function inspectCommandCenterMailMetadataTargets(params: {
  watchPayload: unknown;
  mailbox: string;
}): CommandCenterMailMetadataTarget[] {
  const parsed = parseWatchPayload(params);
  return [...parsed.requestsById.values()].map((request) => ({
    messageId: request.messageId,
    providerThreadId: request.providerThreadId,
  }));
}

export function buildCommandCenterMailDryRunPlan(params: {
  watchPayload: unknown;
  metadataReceipts: unknown;
  mailbox: string;
}): CommandCenterMailDryRunPlan {
  const parsed = parseWatchPayload({ watchPayload: params.watchPayload, mailbox: params.mailbox });
  const metadataReceipts = parseMetadataReceipts(params.metadataReceipts);
  const requests: CommandCenterMailIngestRequest[] = [];
  for (const request of parsed.requestsById.values()) {
    const rfcMessageId = metadataReceipts.get(request.messageId);
    if (!rfcMessageId) {
      fail("missing_metadata", "watch message has no exact RFC Message-ID receipt");
    }
    requests.push({ ...request, rfcMessageId });
  }
  for (const id of metadataReceipts.keys()) {
    if (!parsed.requestsById.has(id)) {
      fail("orphan_metadata", "metadata receipt has no matching watch message");
    }
  }

  return {
    summary: {
      contract: COMMAND_CENTER_MAIL_PLAN_CONTRACT,
      mode: "dry-run",
      ok: true,
      mailbox: parsed.mailbox,
      counts: {
        notifications: 1,
        receivedMessages: parsed.receivedMessages,
        uniqueMessages: requests.length,
        duplicateMessages: parsed.duplicateMessages,
        deletedMessages: parsed.deletedMessages,
        metadataReceipts: metadataReceipts.size,
        readyRequests: requests.length,
      },
      guarantees: {
        networkRequests: 0,
        providerCommands: 0,
        stateWrites: 0,
        outputContainsMessageContent: false,
      },
    },
    requests,
  };
}
