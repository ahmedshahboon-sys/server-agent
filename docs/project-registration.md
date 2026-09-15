# Project registration

The Phase 1 registry stores project metadata only. It does not create, delete, deploy, or modify a project's files.

A project contains an ID, name, absolute root, enabled flag, runtime, optional service/domain, ports, health configuration, configured commands, database adapter metadata, permissions, environment references, and non-secret metadata.

Disabling a registry entry never deletes the project. File access in later phases must combine the registry entry, authorization check, and project filesystem sandbox.
