#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCommandCenterMailDryRunPlan,
  COMMAND_CENTER_MAIL_PLAN_CONTRACT,
  CommandCenterMailPlanError,
} from "./lib/gmail-command-center-adapter.js";

const MAX_INPUT_BYTES = 2_000_000;

type CliOptions = {
  inputPath: string;
  metadataPath: string;
  mailbox: string;
};

function usage(): string {
  return [
    "Usage:",
    "  pnpm gmail:command-center:plan -- --input <gog-watch.json> --metadata <receipts.json> --mailbox <address>",
    "",
    "Dry-run only. Emits count-only JSON and never runs provider commands, writes state, or performs network requests.",
  ].join("\n");
}

export function parseCommandCenterMailPlanArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--" && index === 0) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new CommandCenterMailPlanError("help", usage());
    }
    if (arg === "--apply" || arg === "--send" || arg === "--deliver") {
      throw new CommandCenterMailPlanError(
        "mutation_mode_forbidden",
        "This adapter phase is dry-run only and has no mutation mode",
      );
    }
    if (arg !== "--input" && arg !== "--metadata" && arg !== "--mailbox") {
      throw new CommandCenterMailPlanError(
        "unknown_argument",
        `Unknown argument at position ${index}`,
      );
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CommandCenterMailPlanError(
        "missing_argument_value",
        `Missing value for argument at position ${index}`,
      );
    }
    if (values.has(arg)) {
      throw new CommandCenterMailPlanError("duplicate_argument", `Repeated argument ${arg}`);
    }
    values.set(arg, value);
    index += 1;
  }

  const inputPath = values.get("--input");
  const metadataPath = values.get("--metadata");
  const mailbox = values.get("--mailbox");
  if (!inputPath || !metadataPath || !mailbox) {
    throw new CommandCenterMailPlanError("missing_argument", usage());
  }
  return { inputPath, metadataPath, mailbox };
}

function readBoundedJson(filePath: string, label: string): unknown {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CommandCenterMailPlanError("invalid_input_file", `${label} must be a regular file`);
  }
  if (stat.size <= 0 || stat.size > MAX_INPUT_BYTES) {
    throw new CommandCenterMailPlanError(
      "invalid_input_size",
      `${label} must be between 1 and ${MAX_INPUT_BYTES} bytes`,
    );
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  } catch {
    throw new CommandCenterMailPlanError("invalid_json", `${label} is not valid JSON`);
  }
}

export function runCommandCenterMailPlan(argv: string[]): void {
  const options = parseCommandCenterMailPlanArgs(argv);
  const plan = buildCommandCenterMailDryRunPlan({
    watchPayload: readBoundedJson(options.inputPath, "watch payload"),
    metadataReceipts: readBoundedJson(options.metadataPath, "metadata receipt document"),
    mailbox: options.mailbox,
  });
  process.stdout.write(`${JSON.stringify(plan.summary, null, 2)}\n`);
}

function main(): void {
  try {
    runCommandCenterMailPlan(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CommandCenterMailPlanError && error.code === "help") {
      process.stdout.write(`${error.message}\n`);
      return;
    }
    const code = error instanceof CommandCenterMailPlanError ? error.code : "unexpected_error";
    const message = error instanceof CommandCenterMailPlanError ? error.message : "Dry-run failed";
    process.stderr.write(
      `${JSON.stringify({ contract: COMMAND_CENTER_MAIL_PLAN_CONTRACT, mode: "dry-run", ok: false, code, message })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
