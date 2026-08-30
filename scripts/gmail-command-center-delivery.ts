#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openVerifiedFileSync } from "../src/infra/safe-open-sync.js";
import { safeEqualSecret } from "../src/security/secret-equal.js";
import {
  CommandCenterMailPlanError,
  normalizeCommandCenterMailConfiguredMailbox,
} from "./lib/gmail-command-center-adapter.js";
import {
  COMMAND_CENTER_MAIL_DELIVERY_CONTRACT,
  CommandCenterMailDeliveryError,
  deliverCommandCenterMailWatchPayload,
  isValidCommandCenterMailBearer,
  resolveCommandCenterMailIngestUrl,
  type GogCommandRunner,
  type CommandCenterMailDeliverySummary,
} from "./lib/gmail-command-center-delivery.js";

const LOOPBACK_HOST = "127.0.0.1";
const HOOK_PATH = "/gmail-command-center";
const DEFAULT_PORT = 8789;
const MAX_HOOK_BODY_BYTES = 2_000_000;
const MAX_SECRET_BYTES = 16_384;
const GOG_TIMEOUT_MS = 30_000;
const MAX_COMPLETED_NOTIFICATION_DIGESTS = 128;

type DeliveryCliOptions = {
  mailbox: string;
  commandCenterBaseUrl: string;
  commandCenterTokenFile: string;
  hookTokenFile: string;
  gogBin: string;
  port: number;
  apply: boolean;
  confirmLiveDelivery: boolean;
};

export type SecureSecret = {
  value: string;
  device: bigint;
  inode: bigint;
};

export function assertDistinctSecureSecrets(
  commandCenterSecret: SecureSecret,
  hookSecret: SecureSecret,
): void {
  const sameFile =
    commandCenterSecret.device === hookSecret.device &&
    commandCenterSecret.inode === hookSecret.inode;
  if (sameFile || safeEqualSecret(commandCenterSecret.value, hookSecret.value)) {
    throw new CommandCenterMailDeliveryError(
      "secret_reuse_forbidden",
      "Command Center and local hook bearers must use different files and values",
    );
  }
}

function usage(): string {
  return [
    "Usage:",
    "  pnpm gmail:command-center:deliver -- --mailbox <address> --command-center-url <https-origin> --command-center-token-file <path> --hook-token-file <path> [--gog-bin <path>] [--port <n>]",
    "",
    "Default mode is an offline configuration dry run. Starting the loopback delivery listener requires both --apply and --confirm-live-delivery.",
  ].join("\n");
}

export function parseCommandCenterMailDeliveryArgs(argv: string[]): DeliveryCliOptions {
  const values = new Map<string, string>();
  let apply = false;
  let confirmLiveDelivery = false;
  const valueArguments = new Set([
    "--mailbox",
    "--command-center-url",
    "--command-center-token-file",
    "--hook-token-file",
    "--gog-bin",
    "--port",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--" && index === 0) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new CommandCenterMailDeliveryError("help", usage());
    }
    if (arg === "--apply" || arg === "--confirm-live-delivery") {
      if (
        (arg === "--apply" && apply) ||
        (arg === "--confirm-live-delivery" && confirmLiveDelivery)
      ) {
        throw new CommandCenterMailDeliveryError("duplicate_argument", `Repeated argument ${arg}`);
      }
      if (arg === "--apply") {
        apply = true;
      } else {
        confirmLiveDelivery = true;
      }
      continue;
    }
    if (!valueArguments.has(arg ?? "")) {
      throw new CommandCenterMailDeliveryError(
        "unknown_argument",
        `Unknown argument at position ${index}`,
      );
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CommandCenterMailDeliveryError(
        "missing_argument_value",
        `Missing value for argument at position ${index}`,
      );
    }
    if (values.has(arg)) {
      throw new CommandCenterMailDeliveryError("duplicate_argument", `Repeated argument ${arg}`);
    }
    values.set(arg, value);
    index += 1;
  }

  const mailbox = values.get("--mailbox");
  const commandCenterBaseUrl = values.get("--command-center-url");
  const commandCenterTokenFile = values.get("--command-center-token-file");
  const hookTokenFile = values.get("--hook-token-file");
  if (!mailbox || !commandCenterBaseUrl || !commandCenterTokenFile || !hookTokenFile) {
    throw new CommandCenterMailDeliveryError("missing_argument", usage());
  }
  resolveCommandCenterMailIngestUrl(commandCenterBaseUrl);
  const portText = values.get("--port");
  const port = portText === undefined ? DEFAULT_PORT : Number(portText);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new CommandCenterMailDeliveryError("invalid_port", "Listener port must be 1024-65535");
  }
  if (confirmLiveDelivery && !apply) {
    throw new CommandCenterMailDeliveryError(
      "confirmation_without_apply",
      "--confirm-live-delivery is valid only with --apply",
    );
  }
  if (apply !== confirmLiveDelivery) {
    throw new CommandCenterMailDeliveryError(
      "apply_confirmation_required",
      "Live delivery requires both --apply and --confirm-live-delivery",
    );
  }

  return {
    mailbox: normalizeCommandCenterMailConfiguredMailbox(mailbox),
    commandCenterBaseUrl,
    commandCenterTokenFile,
    hookTokenFile,
    gogBin: values.get("--gog-bin") ?? "gog",
    port,
    apply,
    confirmLiveDelivery,
  };
}

export function readSecureSecret(filePath: string, label: string): SecureSecret {
  const resolved = path.resolve(filePath);
  const opened = openVerifiedFileSync({
    filePath: resolved,
    rejectPathSymlink: true,
    rejectHardlinks: true,
    maxBytes: MAX_SECRET_BYTES,
  });
  if (!opened.ok) {
    throw new CommandCenterMailDeliveryError("invalid_secret_file", `${label} file is invalid`);
  }
  try {
    if (process.platform !== "win32" && (opened.stat.mode & 0o777) !== 0o600) {
      throw new CommandCenterMailDeliveryError(
        "invalid_secret_permissions",
        `${label} file must have mode 0600`,
      );
    }
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && opened.stat.uid !== currentUid) {
      throw new CommandCenterMailDeliveryError(
        "invalid_secret_owner",
        `${label} file must be owned by the current user`,
      );
    }
    const value = fs.readFileSync(opened.fd, "utf8").trim();
    if (!isValidCommandCenterMailBearer(value)) {
      throw new CommandCenterMailDeliveryError("invalid_secret", `${label} value is invalid`);
    }
    return {
      value,
      device: BigInt(opened.stat.dev),
      inode: BigInt(opened.stat.ino),
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

function runGogCommand(gogBin: string): GogCommandRunner {
  return async (args) =>
    await new Promise<string>((resolve, reject) => {
      execFile(
        gogBin,
        [...args],
        {
          encoding: "utf8",
          maxBuffer: 1_000_000,
          timeout: GOG_TIMEOUT_MS,
          windowsHide: true,
          env: { ...process.env, NO_COLOR: "1" },
        },
        (error, stdout) => {
          if (error) {
            reject(
              new CommandCenterMailDeliveryError(
                "provider_receipt_failed",
                "Gmail metadata receipt command failed",
              ),
            );
            return;
          }
          resolve(stdout);
        },
      );
    });
}

async function readHookBody(request: IncomingMessage): Promise<{ value: unknown; digest: string }> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) {
      throw new CommandCenterMailDeliveryError(
        "invalid_hook_length",
        "Hook Content-Length is invalid",
      );
    }
    if (Number(contentLength) > MAX_HOOK_BODY_BYTES) {
      throw new CommandCenterMailDeliveryError("hook_body_too_large", "Hook body is too large");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_HOOK_BODY_BYTES) {
      throw new CommandCenterMailDeliveryError("hook_body_too_large", "Hook body is too large");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks, total);
  try {
    return {
      value: JSON.parse(raw.toString("utf8")) as unknown,
      digest: createHash("sha256").update(raw).digest("hex"),
    };
  } catch {
    throw new CommandCenterMailDeliveryError("invalid_hook_json", "Hook body is not valid JSON");
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function safeError(error: unknown): { code: string; message: string } {
  if (
    error instanceof CommandCenterMailDeliveryError ||
    error instanceof CommandCenterMailPlanError
  ) {
    return { code: error.code, message: error.message };
  }
  return { code: "unexpected_error", message: "Mail delivery failed" };
}

export function createCommandCenterMailDeliveryHandler(params: {
  mailbox: string;
  commandCenterBaseUrl: string;
  commandCenterBearer: string;
  hookBearer: string;
  runGog: GogCommandRunner;
  fetchImpl?: typeof globalThis.fetch;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  let active = false;
  const completed = new Map<string, CommandCenterMailDeliverySummary>();
  return async (request, response) => {
    response.once("error", () => undefined);
    if (request.method !== "POST" || request.url !== HOOK_PATH) {
      writeJson(response, 404, { ok: false, code: "not_found" });
      return;
    }
    const authorization = request.headers.authorization;
    const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!safeEqualSecret(provided, params.hookBearer)) {
      writeJson(response, 401, { ok: false, code: "unauthorized" });
      return;
    }
    if (
      request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    ) {
      writeJson(response, 415, { ok: false, code: "unsupported_media_type" });
      return;
    }
    if (active) {
      writeJson(response, 503, { ok: false, code: "delivery_busy" });
      return;
    }
    active = true;
    try {
      const hookBody = await readHookBody(request);
      const previous = completed.get(hookBody.digest);
      if (previous) {
        const replay: CommandCenterMailDeliverySummary = {
          ...previous,
          counts: {
            ...previous.counts,
            providerMetadataReads: 0,
            deliveryAttempts: 0,
            createdMessages: 0,
            reusedMessages: 0,
            replayedNotifications: 1,
          },
        };
        process.stdout.write(`${JSON.stringify(replay)}\n`);
        writeJson(response, 200, replay);
        return;
      }
      const summary = await deliverCommandCenterMailWatchPayload({
        watchPayload: hookBody.value,
        mailbox: params.mailbox,
        commandCenterBaseUrl: params.commandCenterBaseUrl,
        commandCenterBearer: params.commandCenterBearer,
        runGog: params.runGog,
        fetchImpl: params.fetchImpl,
      });
      completed.set(hookBody.digest, summary);
      if (completed.size > MAX_COMPLETED_NOTIFICATION_DIGESTS) {
        const oldest = completed.keys().next().value;
        if (oldest) {
          completed.delete(oldest);
        }
      }
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      writeJson(response, 200, summary);
    } catch (error) {
      const safe = safeError(error);
      const payload = {
        contract: COMMAND_CENTER_MAIL_DELIVERY_CONTRACT,
        mode: "apply",
        ok: false,
        ...safe,
      };
      process.stderr.write(`${JSON.stringify(payload)}\n`);
      writeJson(response, 503, payload);
    } finally {
      active = false;
    }
  };
}

export async function runCommandCenterMailDelivery(argv: string[]): Promise<void> {
  const options = parseCommandCenterMailDeliveryArgs(argv);
  if (!options.apply) {
    process.stdout.write(
      `${JSON.stringify(
        {
          contract: COMMAND_CENTER_MAIL_DELIVERY_CONTRACT,
          mode: "dry-run",
          ok: true,
          counts: { listeners: 0, networkRequests: 0, providerCommands: 0, secretFilesRead: 0 },
          guarantees: {
            loopbackOnly: true,
            outputContainsMessageContent: false,
            deliveryRequiresTwoFlags: true,
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const commandCenterSecret = readSecureSecret(
    options.commandCenterTokenFile,
    "Command Center bearer",
  );
  const hookSecret = readSecureSecret(options.hookTokenFile, "local hook bearer");
  assertDistinctSecureSecrets(commandCenterSecret, hookSecret);
  const server = http.createServer(
    createCommandCenterMailDeliveryHandler({
      mailbox: options.mailbox,
      commandCenterBaseUrl: options.commandCenterBaseUrl,
      commandCenterBearer: commandCenterSecret.value,
      hookBearer: hookSecret.value,
      runGog: runGogCommand(options.gogBin),
    }),
  );
  server.headersTimeout = 10_000;
  server.requestTimeout = 600_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, LOOPBACK_HOST, resolve);
  });
  process.stdout.write(
    `${JSON.stringify({
      contract: COMMAND_CENTER_MAIL_DELIVERY_CONTRACT,
      mode: "apply",
      ok: true,
      state: "listening",
      counts: { listeners: 1, networkRequests: 0, providerCommands: 0 },
      guarantees: { loopbackOnly: true, outputContainsMessageContent: false },
    })}\n`,
  );
}

async function main(): Promise<void> {
  try {
    await runCommandCenterMailDelivery(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CommandCenterMailDeliveryError && error.code === "help") {
      process.stdout.write(`${error.message}\n`);
      return;
    }
    const safe = safeError(error);
    process.stderr.write(
      `${JSON.stringify({
        contract: COMMAND_CENTER_MAIL_DELIVERY_CONTRACT,
        mode: "startup",
        ok: false,
        ...safe,
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
