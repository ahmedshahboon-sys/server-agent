# Project registration

The registry stores project metadata and safety configuration. Disabling/removing a registration does not delete project files.

A project contains an ID, name, absolute root, enabled flag, runtime, optional service/domain, ports, health configuration, fixed commands, database configuration, deployment strategy, permissions, environment references, and non-secret metadata.

## Database

`database.adapter` declares the engine. Phase 3 implements project SQLite access. SQLite uses a project-relative metadata path ending in `.db`, `.sqlite`, or `.sqlite3`; canonical sandbox resolution prevents escape. Other engines remain extension points until their adapters are implemented. Credentials must use secret/environment references, never metadata values.

## Deployment

`deployment` includes the strategy, optional required branch, clean-tree policy, validation requirement, optional service restart, and health requirement. A `command` strategy requires `commands.deploy`. A health-required deployment cannot use health type `none`. HTTP health may explicitly choose `http` or `https`; if a health port is set it must be one of the project's registered ports.

## Commands and validation

Commands are argv arrays, not shell strings. `build`, `test`, and `deploy` have dedicated entries. Additional commands live under `allowed`, and `validation` is an ordered list of configured command IDs.
