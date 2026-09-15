# MCP tool boundary

MCP transport and tool schemas are implemented in Phase 4. The architecture already keeps transport outside the core.

Every future MCP tool must pass through authentication/authorization, project scope where applicable, safe service interfaces, redaction, and bounded responses. MCP must never become an unrestricted shell or bypass project sandboxing.
