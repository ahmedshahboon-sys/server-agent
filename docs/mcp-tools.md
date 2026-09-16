# MCP tool boundary

MCP transport and public tool schemas are implemented in Phase 4. Phase 2 implements the transport-independent services those tools will call.

Available service foundations now cover:

- files: list/read/search/write/edit/delete;
- Git: status/diff/log/branch/commit;
- restricted configured commands;
- jobs/process tracking;
- persistent tasks/checkpoints/resume/pause/cancel;
- Local CI validation and bounded attempts;
- idempotency records.

Every future MCP tool must still pass through authentication/authorization, project scope, registered project capability, safe service interfaces, redaction, and bounded responses. MCP must never become an unrestricted shell or bypass project sandboxing.
