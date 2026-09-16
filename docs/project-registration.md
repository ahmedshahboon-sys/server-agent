# Project registration

The registry stores project metadata and safety configuration. It does not delete a project when a registration is disabled or removed.

A project contains an ID, name, absolute root, enabled flag, runtime, optional service/domain, ports, health configuration, configured commands, database adapter metadata, permissions, environment references, and non-secret metadata.

## Commands and validation

Commands are argv arrays, not shell strings. `build`, `test`, and `deploy` have dedicated optional entries. Additional commands live under `allowed`, and `validation` is an ordered list of command ids used by Local CI.

A validation step must reference a configured command. This catches broken project registration before execution.

Project access combines registry capability, caller authorization, and the project filesystem sandbox.
