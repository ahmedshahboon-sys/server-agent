# Server Agent

Server Agent is a production-safety-focused control layer intended to let ChatGPT operate on multiple server projects through a constrained MCP interface. ChatGPT remains the reasoning layer; Server Agent provides scoped tools, durable state, validation, deployment safety, recovery, and project isolation.

> Status: Phase 1/5 foundation and security. This repository does not contain production credentials and does not deploy to production from GitHub Actions.

## Core principles

- Least privilege and default deny.
- Explicit project scope and realpath-based filesystem isolation.
- No open remote shell.
- No secrets in task state, logs, repository configuration, or CI.
- Local validation remains part of the final product; GitHub CI is development validation only.
- SQLite for durable Server Agent state; no Redis or additional database server.
- Core logic remains independent from MCP transport.

## Development

Requires Node.js 22+ (CI currently validates with Node.js 24).

```bash
npm install
npm run validate
```

See `docs/architecture.md` and `docs/security-model.md` for the Phase 1 design.
