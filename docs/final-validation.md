# Final production-candidate validation model

This repository is considered ready for operator-controlled installation only when the final hardening branch, its pull request, and merged `main` all pass the complete validation pipeline on clean GitHub-hosted Ubuntu runners.

## Required validation gates

- dependency tree validation;
- lint and strict TypeScript typecheck;
- complete unit/integration suite;
- dedicated security regression suite;
- production build;
- repository secret scan;
- install-package structural validation;
- shell syntax validation for install/uninstall helpers;
- runtime smoke test using a temporary loopback MCP server;
- `/healthz` liveness and `/readyz` readiness checks;
- state-schema migration test through OAuth schema v9;
- maintenance/retention and low-disk fail-closed regression tests;
- modern MCP Tasks extension negotiation/routing regression tests;
- official MCP TypeScript SDK v2 compatibility smoke;
- full validation on Node.js 22 and 24;
- idle RSS sanity check;
- post-merge CI on `main`.

## Memory-conscious architecture

The runtime intentionally uses:

- one main Node.js process;
- built-in `node:sqlite` for Agent state;
- no Redis, queue server, additional Agent database server, or Docker requirement;
- no runtime npm dependencies;
- one concurrent heavy command job by default;
- bounded command/log/file/database/MCP request sizes;
- process and systemd resource limits.

The runtime smoke check treats 256 MiB idle RSS as a generous CI sanity ceiling rather than a production promise. Real target-host memory must be measured again during installation because Node/kernel versions and registered workloads differ.

## Security hardening checklist

- filesystem paths are canonicalized and symlink escapes are blocked;
- sensitive files are denied by default;
- secret-like data is recursively redacted;
- MCP authentication is independent from project/tool authorization;
- non-loopback MCP bind requires an explicit opt-in;
- request body, headers, methods, protocol metadata, Origin, and tool name are validated;
- modern MCP client-capabilities metadata is required;
- command execution is argv-only and allowlisted per project;
- long direct commands/tests are persistent Jobs rather than connection-bound work;
- command timeout/cancellation escalates from `SIGTERM` to `SIGKILL` if needed;
- URL health probes resolve DNS first, reject private/reserved answers, and connect to the validated IP to reduce DNS-rebinding SSRF risk;
- destructive SQL is not part of the normal query interface;
- deployment and rollback require checkpoints/evidence/health checks;
- recovery and fix attempts are bounded;
- CI contains no production credentials and never connects to production;
- maintenance mode blocks mutating MCP operations while preserving read/diagnostic access;
- mutating work fails closed when configured free-disk headroom is unavailable;
- startup maintenance prunes bounded stale telemetry/job-log files and checkpoints SQLite WAL without deleting deployment/rollback evidence required for recovery;
- MCP Tasks extension is opt-in through `io.modelcontextprotocol/tasks`; task follow-up requests require `Mcp-Name` equal to `taskId`; cancellation is cooperative and never blindly kills safety-critical deploy/rollback work.

## Installation-package checklist

Expected artifacts:

```text
install/
  install.sh
  uninstall.sh
  server-agent.env.example
  systemd/
    server-agent.service.template

docs/
  installation.md
  cloudflare-remote-mcp.md
  chatgpt-oauth.md
  operations.md
  final-validation.md
```

The installer must not modify DNS, Nginx, firewall rules, Cloudflare, Docker, or registered project trees. It prepares the service but leaves it disabled unless the operator explicitly supplies `--enable`.

## Known intentional limits

- The database adapter architecture is extensible, but this build implements direct project-database execution only for SQLite. Other adapter names are registered architecture targets and fail closed until implemented.
- Cloudflare Tunnel/Access is documented but not installed or configured automatically. ChatGPT OAuth is optional and disabled by default until an operator supplies an HTTPS public base URL and owner secret.
- Project service restart requires an explicit narrow OS-level authorization policy if used; none is created automatically.
- Project registration is not automatic. Production projects are added later, starting with deliberately narrow permissions.

These limits are intentional safety boundaries, not silent fallbacks.
