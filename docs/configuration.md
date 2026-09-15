# Configuration

Phase 1 non-secret configuration is environment based:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SERVER_AGENT_DATA_DIR` | `./.runtime` | Agent-owned data directory |
| `SERVER_AGENT_DB_PATH` | `<data-dir>/server-agent.sqlite` | SQLite state database |
| `SERVER_AGENT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `SERVER_AGENT_MAX_FILE_BYTES` | `1048576` | Foundation limit for future file tools |

Secrets must not be placed in repository config or SQLite records. Project configuration stores environment-variable references such as `PROJECT_A_DB_URL`, not values.
