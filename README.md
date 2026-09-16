# Server Agent

Server Agent is a production-safety-focused control layer for operating multiple server projects through a constrained remote MCP interface. ChatGPT remains the reasoning layer; Server Agent provides scoped deterministic tools, durable state, validation, deployment safety, recovery/rollback evidence, and project isolation.

> Status: Phase 5/5 source package. Installation artifacts are prepared, but this repository does not automatically install on or connect to production. GitHub Actions never deploys to production and contains no production credentials.

## Implemented

- SQLite Project Registry with explicit per-project roots, commands, permissions, health, database, and deployment configuration.
- Canonical realpath filesystem sandbox, sensitive-file policy, default-deny authorization, and recursive secret redaction.
- Project-scoped file tools and fixed safe Git operations.
- Restricted argv-only command execution with no shell, timeouts, output limits, cancellation escalation, and default single heavy-job concurrency.
- Persistent Jobs for remote commands/tests, durable Tasks/checkpoints, crash reconciliation, validation history, and idempotency foundations.
- Database adapter architecture with direct SQLite project-database support, bounded reads/writes, classification, transaction support, migration-status inspection, audit hashes, worker timeout, and destructive-query blocking.
- Deployment engine with prechecks, validation, migration evidence, deployment records, optional service restart, post-deploy health, and rollback references.
- Evidence-driven Recovery Engine with bounded attempts and explicit `RECOVERY_REQUIRED`, rollback, and `WAITING_FOR_USER` states.
- Guarded Rollback Engine with READY plan, Git revalidation, explicit rollback command, migration-safety checks, and health validation.
- Stateless MCP `2026-07-28` HTTP transport with bearer authentication abstraction, project/tool authorization, request metadata validation, Origin/body bounds, redacted responses, and MCP audit.
- HTTP health SSRF protection using DNS resolution, private/reserved-address rejection, validated-IP connection pinning, and no redirects.
- Executable runtime entrypoint, non-root systemd template, idempotent install helper, safe uninstall helper, Cloudflare remote-MCP preparation, backup/upgrade/recovery documentation, and runtime/memory smoke validation.

## Core principles

- Least privilege and default deny.
- Explicit project scope and project capability checks.
- MCP binds to loopback by default; public bind requires explicit opt-in.
- No open remote shell or arbitrary URL fetcher.
- No secrets in task state, project registry, repository configuration, CI, or MCP audit arguments.
- No blind destructive database action, deploy success, recovery replay, or rollback.
- Git rollback and database rollback are separate safety domains.
- Local validation remains part of the product; GitHub CI is development validation only.
- One lightweight Node.js runtime process, built-in SQLite state, no Redis/queue server/Docker requirement, and no runtime npm dependencies.

## Development validation

Requires Node.js 22+; GitHub CI validates with Node.js 24.

```bash
npm install --ignore-scripts
npm run validate
```

`npm run validate` performs dependency validation, lint, strict typecheck, all tests, dedicated security tests, build, secret scan, install-package validation, live loopback MCP smoke test, and idle RSS sanity checking.

## Installation

The expected later installation checkout is `/opt/server-agent`, but **do not run installation merely by cloning this repository**. Follow the separate operator-controlled installation phase in `docs/installation.md`.

Important documentation:

- `docs/architecture.md`
- `docs/security-model.md`
- `docs/configuration.md`
- `docs/mcp-tools.md`
- `docs/deployment.md`
- `docs/recovery.md`
- `docs/installation.md`
- `docs/cloudflare-remote-mcp.md`
- `docs/operations.md`
- `docs/final-validation.md`
