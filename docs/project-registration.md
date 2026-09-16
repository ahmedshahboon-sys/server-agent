# Project registration

The registry stores project metadata and safety configuration. Disabling/removing a registration does not delete project files.

A project contains an ID, name, absolute root, enabled flag, runtime, optional service/domain, ports, health configuration, fixed commands, database configuration, deployment strategy, permissions, environment references, and non-secret metadata.

## Start narrow

Production registration is a later installation step, not part of source build/CI. Register a project with the smallest useful capability set first (normally read-only inspection), verify sandbox/Git/log/health/database behavior, then add write/deploy/restart permissions only for explicit workflows.

The remote principal permission and scope do not override project permissions. Both must allow an operation.

## Database

`database.adapter` declares the engine. This build implements project SQLite access. SQLite uses a project-relative metadata path ending in `.db`, `.sqlite`, or `.sqlite3`; canonical sandbox resolution prevents escape. Other declared engines remain extension points until their adapters are implemented and fail closed if selected for direct execution.

Credentials use environment/secret references, never registry metadata values. `defaultAccess` should remain `read` unless controlled write is explicitly required.

## Deployment

`deployment` includes the strategy, optional required branch, clean-tree policy, validation requirement, optional service restart, and health requirement. A `command` strategy requires `commands.deploy`. A health-required deployment cannot use health type `none`. HTTP health may explicitly choose `http` or `https`; if a health port is set it must be one of the project's registered ports.

Service restart also requires host OS authorization for the dedicated Agent user; project permission alone cannot create that privilege.

## Commands and validation

Commands are argv arrays, not shell strings. `build`, `test`, `deploy`, and `rollback` have dedicated entries. Additional commands live under `allowed`, and `validation` is an ordered list of configured command IDs.

Rollback is not available through the generic `run_command` path. A rollback command must be configured explicitly for the Rollback Engine and contain `{target_commit}`, which is replaced only with a validated full Git commit SHA after rollback planning/revalidation.
