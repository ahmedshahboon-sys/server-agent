# Configuration

Non-secret Server Agent configuration is environment based:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SERVER_AGENT_DATA_DIR` | `./.runtime` | Agent-owned state/output directory |
| `SERVER_AGENT_DB_PATH` | `<data-dir>/server-agent.sqlite` | SQLite state database |
| `SERVER_AGENT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `SERVER_AGENT_MAX_FILE_BYTES` | `1048576` | File read/write bound |
| `SERVER_AGENT_MAX_COMMAND_OUTPUT_BYTES` | `262144` | Maximum captured stdout/stderr per stream |
| `SERVER_AGENT_COMMAND_TIMEOUT_MS` | `120000` | Default project-command timeout |
| `SERVER_AGENT_MAX_FIX_ATTEMPTS` | `3` | Local validation retry ceiling |
| `SERVER_AGENT_MAX_CONCURRENT_JOBS` | `1` | Concurrent job ceiling |

Secrets must not be placed in repository config or SQLite records. Project configuration stores environment-variable references such as `PROJECT_A_DB_URL`, not values.
