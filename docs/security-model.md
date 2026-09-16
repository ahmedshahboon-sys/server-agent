# Security model

## Default deny

A project operation requires explicit caller permission and project scope. Phase 2 tools also require the registered project to enable that capability. Cross-project access is denied even if the caller holds the tool permission.

## Filesystem sandbox

User-supplied paths are rejected when absolute, traversal-based, encoded traversal/null sequences, or when canonical resolution escapes the project root. Existing paths use `realpath`; write targets verify the nearest existing ancestor and existing symlink targets.

String-prefix checks are not the security boundary.

## Sensitive files

Ordinary file tools deny common environment, credential, token, private-key, and certificate file names. Search skips paths that policy does not allow instead of exposing their contents.

## Command execution

`run_command` foundations do not accept arbitrary shell strings. A project registers fixed argv arrays, the caller selects a command id, and execution uses `shell: false`. Common system-control and shell executables are blocked even if accidentally configured. Commands have timeouts, bounded stdout/stderr, cancellation hooks, and bounded concurrency.

Only selected baseline environment variables and explicitly referenced project environment variables are passed to project commands. Known runtime secret values are removed from captured output.

## Git

Git operations are fixed service methods. There is no reset-hard, clean, forced checkout, or force push. Commit hooks are disabled for Agent-created commits so a repository-local hook cannot become an implicit command-execution path.

## Secret handling

Structured logs and persisted errors redact sensitive keys, bearer tokens, assignments, credential-bearing URLs, private-key blocks, and known runtime secret values. Registry records accept environment references rather than secret values.

## GitHub CI

GitHub-hosted runners are used only for source validation. Workflows have read-only repository permissions, contain no deployment steps, use no production credentials, and do not connect to production infrastructure.
