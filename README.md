# Server Agent

Server Agent is a production-safety-focused control layer intended to let ChatGPT operate on multiple server projects through a constrained MCP interface. ChatGPT remains the reasoning layer; Server Agent provides scoped tools, durable state, validation, deployment safety, recovery, and project isolation.

> Status: Phase 2/5 — Tools + Tasks + Local CI. The repository contains no production credentials and GitHub Actions never deploys to production.

## Implemented foundation

- Project Registry backed by SQLite.
- Realpath filesystem sandbox and sensitive-file policy.
- Default-deny authorization and secret redaction.
- Project-scoped file tools.
- Fixed Git operations without reset/clean/force operations.
- Restricted command execution using fixed argv and `shell: false`.
- Timeouts, output limits, cancellation hooks, command logging foundations, and runtime-secret redaction.
- Persistent jobs with pid/status/output locations and restart reconciliation.
- Persistent tasks, checkpoints, pause/resume/cancel, crash-state recovery marking, and activity records.
- Local CI validation pipeline with bounded attempts.
- Idempotency-key persistence foundations.

## Core principles

- Least privilege and default deny.
- Explicit project scope and project capability checks.
- No open remote shell.
- No secrets in task state, logs, repository configuration, or CI.
- Local validation remains part of the final product; GitHub CI is development validation only.
- SQLite for durable Server Agent state; no Redis or additional database server.
- Core logic remains independent from MCP transport.

## Development

Requires Node.js 22+ (GitHub CI validates with Node.js 24).

```bash
npm ci
npm run validate
```

See `docs/architecture.md`, `docs/security-model.md`, and `docs/local-ci.md`.
