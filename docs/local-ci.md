# Local CI design

The product's Local CI engine is scheduled for Phase 2. Phase 1 establishes the validation contract used while developing Server Agent itself:

```text
lint -> typecheck -> tests -> build -> secret scan
```

GitHub Actions mirrors these source-level checks using GitHub-hosted runners. It is not the future Local CI engine and has no production access.
