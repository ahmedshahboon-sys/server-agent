# Server Agent

Server Agent is a production-safety-focused control layer intended to let ChatGPT operate on multiple server projects through a constrained MCP interface. ChatGPT remains the reasoning layer; Server Agent provides scoped tools, durable state, validation, deployment safety, recovery, and project isolation.

> Status: Phase 3/5 — Database + Deployment + Health. The repository contains no production credentials and GitHub Actions never deploys to production.

## Implemented through Phase 3

- Project Registry backed by SQLite.
- Realpath filesystem sandbox, sensitive-file policy, default-deny authorization, and secret redaction.
- Project-scoped file tools and fixed safe Git operations.
- Restricted argv-only command execution with timeouts, output limits, cancellation, and bounded concurrency foundations.
- Persistent jobs, tasks, checkpoints, validation history, and idempotency records.
- Local CI validation with bounded attempts.
- Database adapter architecture with SQLite implementation, schema inspection, migration-status inspection, bounded results, hard worker timeout, read/write classification, transaction support, audit hashes, and destructive-query blocking.
- Deployment engine with Git/branch/clean-state checks, validation, migration-status check, checkpoint/rollback reference, deployment records, optional service restart, and mandatory post-deploy health validation when configured.
- Health checks for service, HTTP/HTTPS, database, or composite modes with durable results.
- systemd service-controller abstraction and bounded/redacted journal-log reader.

## Core principles

- Least privilege and default deny.
- Explicit project scope and project capability checks.
- No open remote shell.
- No secrets in task state, logs, repository configuration, or CI.
- No blind destructive database actions or blind deploy success.
- Local validation remains part of the final product; GitHub CI is development validation only.
- SQLite for durable Server Agent state; no Redis or additional state database server.
- Core logic remains independent from MCP transport.

## Development

Requires Node.js 22+ (GitHub CI validates with Node.js 24).

```bash
npm ci
npm run validate
```

See `docs/architecture.md`, `docs/security-model.md`, `docs/local-ci.md`, and `docs/deployment.md`.
