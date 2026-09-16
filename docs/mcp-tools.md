# MCP tool boundary

MCP transport and public tool schemas arrive in Phase 4. Phase 3 extends the transport-independent service layer that MCP will call.

Service foundations now cover files, Git, restricted commands, jobs/tasks/checkpoints, Local CI, idempotency, database status/schema/query/transaction/migration status, deployment records/execution, health checks, service status/restart abstraction, and bounded journal logs.

Every future MCP tool must still pass authentication/authorization, project scope, registered project capability, safe service interfaces, redaction, and bounded responses. MCP must never become an unrestricted shell, arbitrary URL fetcher, destructive database console, or sandbox bypass.
