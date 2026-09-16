# Local CI

Server Agent has a transport-independent Local CI pipeline. Each registered project can define fixed command argv values and an ordered validation pipeline.

Example project command policy:

```json
{
  "allowed": {
    "lint": ["npm", "run", "lint"],
    "typecheck": ["npm", "run", "typecheck"]
  },
  "test": ["npm", "test"],
  "build": ["npm", "run", "build"],
  "validation": ["lint", "typecheck", "test", "build"]
}
```

Validation executes sequentially and stops on the first failure. Results contain exit code, bounded/redacted stdout and stderr, timing, truncation state, and the failed step. Validation runs are persisted in SQLite and tied to a task/project.

`SERVER_AGENT_MAX_FIX_ATTEMPTS` defaults to `3`. When the limit is reached the pipeline refuses another attempt instead of looping indefinitely.

Project commands are not shell strings. They are fixed argv arrays executed with `shell: false`. Runtime callers select a configured command id and cannot append arbitrary shell syntax.

GitHub Actions remains development-only validation for Server Agent source. It has no production access and is not a replacement for Local CI.
