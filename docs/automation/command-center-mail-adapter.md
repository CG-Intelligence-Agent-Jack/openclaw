---
summary: "Plan a fail-closed Gmail watcher payload for Command Center ingest without provider or network activity"
title: "Command Center mail adapter dry run"
read_when:
  - You are validating a Gmail watcher payload before enabling Command Center delivery
  - You need the dry-run boundary and later rollout requirements for the fleet mail adapter
---

# Command Center mail adapter dry run

The fleet adapter planning command validates a `gog gmail watch serve` payload and builds the
corresponding Command Center ingest requests in memory. It emits only counts. This phase cannot
run provider commands, call Command Center, write cursor state, or deliver mail.

```bash
pnpm gmail:command-center:plan -- \
  --input ./synthetic-watch.json \
  --metadata ./synthetic-metadata.json \
  --mailbox watcher@example.test
```

The watch document uses the upstream Gmail watcher shape. The separate metadata document supplies
one exact RFC Message-ID receipt for each provider message:

```json
{
  "messages": [
    {
      "id": "provider-message-1",
      "rfcMessageId": "<synthetic-1@example.test>"
    }
  ]
}
```

The split is deliberate: the upstream watch payload carries the Gmail provider message and thread
ids but does not carry the RFC Message-ID header required by downstream reply provenance. A later,
separately approved runtime phase must obtain that receipt with a metadata-only provider read before
posting anything.

## Fail-closed contract

- The configured mailbox must exactly match the watcher account.
- Every planned message must be an `INBOX` message with one provider id, one provider thread id, one
  normalized sender address, a non-empty subject and complete plain-text body, and one exact
  bracketed RFC Message-ID receipt.
- Truncated bodies, missing receipts, account drift, malformed identities, and conflicting duplicate
  provider ids reject the whole plan.
- The provider message id becomes Command Center's stable `messageId` deduplication key.
- The configured mailbox, never the message's untrusted `To` header, becomes the ingest mailbox.
- Output is the count-only `cg-command-center-mail-ingest-plan-v1` summary. Sender, subject, body,
  provider ids, RFC ids, and request bodies are never printed.
- There is no `--apply`, `--send`, or `--deliver` mode.

## Later rollout gate

Do not install or schedule this path yet. A later reviewed phase must add and verify all of the
following before activation:

1. A metadata-only `gog gmail get` receipt reader for the exact provider message id.
2. A deployment-held Command Center agent bearer loaded from a mode-0600 file, never process
   arguments, config JSON, or logs.
3. Sequential POST delivery to `/api/mail/messages`, treating `201` fresh and `200` duplicate reuse
   as success and every other response as retryable failure.
4. Delivery-before-cursor-advance behavior so `gog` retains its history cursor when downstream
   delivery fails. Replayed messages must converge through Command Center's stable message id.
5. Count-only logs and reconciliation. No sender, subject, body, provider id, RFC id, OAuth code, or
   bearer value may enter operator logs.
6. Separate approval for host installation, Gmail OAuth, production ingest, and the first count-only
   canary.
