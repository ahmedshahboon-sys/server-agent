# Security model

## Default deny

Authorization requires both an explicit tool permission and explicit project scope. Cross-project access is denied even if the caller holds the tool permission.

## Filesystem sandbox

User-supplied paths are rejected when they are absolute, contain `..` path segments, encoded traversal/null sequences, or resolve outside a project's canonical root. Existing paths are verified with `realpath`; write targets verify their nearest existing ancestor and existing symlink targets.

String-prefix checks are intentionally not used as the security boundary.

## Sensitive files

Default reads and writes are denied for common environment, credentials, token, private-key, and certificate file names. Future privileged capabilities may add explicit policy-controlled exceptions; ordinary tools must not bypass this policy.

## Secret handling

Structured logs redact sensitive keys, bearer tokens, secret assignments, credential-bearing URLs, and private-key blocks before output. Project registry records accept references to environment variables rather than secret values, and reject secret-like metadata keys.

## GitHub CI

GitHub-hosted runners are used only for source validation. Workflows have read-only repository permissions, contain no deployment steps, do not use production credentials, and do not connect to production infrastructure.
