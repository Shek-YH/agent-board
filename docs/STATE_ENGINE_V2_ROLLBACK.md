# State Engine V2 Rollback Notes

## Immediate rollback

Set:

```text
STATE_ENGINE_V2=off
```

Restart Agent Board. Legacy Store maps, `state`, `lifecycle_state`, existing adapters and notification paths remain the primary behavior.

## Code rollback

The first local State Engine checkpoint is commit `b910a5f`; later uncommitted/current Work Items are scoped in `git status`. Revert only the State Engine V2 commits/files after reviewing the diff; never use `git reset --hard` or `git clean` against the worktree.

## Persistence boundary

Do not delete or rewrite `%LOCALAPPDATA%\\AgentBoard` data as a rollback step. V2 persistence is not yet enabled by default and must use a separate versioned snapshot with validation/backup before any migration.

## Manual acceptance rollback

If a real Agent or installed package shows a false completed state, return to `off`, export only the redacted diagnostic bundle if available, and retain the Evidence sequence for a fixture-based fix.
