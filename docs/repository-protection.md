# Repository protection policy

The authoritative desired GitHub ruleset payload is `.github/rulesets/protect-main.json`.

It targets the default branch and requires:

- pull-request-only changes with review-thread resolution;
- successful `Validate Node 22`, `Validate Node 24`, and `MCP SDK compatibility` status checks;
- the branch to be up to date before merge;
- no branch deletion;
- no non-fast-forward/force pushes.

The Server Agent GitHub connection used during hardening has repository-content and pull-request access but no Repository Administration write action, so source automation cannot activate this account-level setting. Apply the ruleset from GitHub Repository Settings > Rules > Rulesets or through an administrator-authorized GitHub API client using this checked-in payload. After activation, verify that `main` reports active protection before production installation.

Do not weaken CI to make the ruleset easier to satisfy. The check names above are intentionally stable and are the required production gate.
