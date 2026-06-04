# Admin Stats and DB Inspector Reliability Design

## Goal

Improve read-only Azure SQL inspection reliability and add a quick admin-facing SQL
view for posteriori gameplay metrics, including completion rate by difficulty,
while keeping automated traffic out of real-player stats.

## Current Context

- Production runs with `STORAGE_BACKEND=mssql`, and the deployed backend can serve
  DB-backed traffic through the existing `make db-port-forward-check` path.
- `make db-inspect-live` currently executes `scripts/db-inspect.cjs` inside the
  running backend pod. This path can fail intermittently when Azure SQL serverless
  is waking from auto-pause because the first connection attempt times out before
  the database is ready.
- The app currently records:
  - `sessions`: one row per started scenario
  - `leaderboard_entries`: one best-score row per nickname and difficulty
  - `gameplay_metrics`: schema exists, but runtime recording is not yet wired in
- `sessions.used = 1` currently means the score-submission token was consumed,
  making it the best available proxy for "completed run" in the current product.
- Test traffic currently looks like normal player traffic because no durable
  source classification is stored in SQL.

## Chosen Approach

Use a minimal production-safe expansion of the current SQL model:

1. Harden `scripts/db-inspect.cjs` with bounded retry behavior so read-only
   inspection survives Azure SQL cold-start latency.
2. Add a `traffic_source` classification to persisted gameplay tables that feed
   current or future analytics:
   - `sessions`
   - `leaderboard_entries`
   - `gameplay_metrics`
3. Mark automated and integration traffic as non-production using a dedicated
   metadata field rather than special-case nicknames.
4. Add an admin-oriented read-only SQL view/query that reports attempts,
   completions, and completion rate by difficulty while excluding non-production
   traffic.

## Data Design

### Traffic source

Persist a constrained string field named `traffic_source` with values:

- `player` for normal user traffic
- `automated` for test, CI, seeded, or scripted traffic

Default all runtime paths to `player` unless an explicit override is provided by
the server-side caller.

### Attempts and completions

- **Attempted game:** one row in `sessions`
- **Completed game:** one row in `sessions` where `used = 1`

This intentionally uses the current behavior instead of inventing a broader
status model in this PR. A future lifecycle PR can replace this proxy with
explicit `started/completed/abandoned` events.

### Admin stats query

The quick admin view should aggregate from `sessions`, filtering to
`traffic_source = 'player'`, and report at least:

- difficulty
- attempts
- completions
- completion percentage

It should be callable through the existing read-only DB inspection workflow so no
new privileged runtime surface is required.

## Implementation Boundaries

### In scope

- SQL schema migration for `traffic_source`
- Storage type and method updates needed to persist `traffic_source`
- Runtime plumbing so scenario creation and score submission persist the correct
  source classification
- Automated tests using `traffic_source = 'automated'`
- Read-only admin query support and docs
- DB inspector retry logic for cold resumes

### Out of scope

- Full gameplay lifecycle telemetry such as `abandoned` or `first_action`
- UI dashboard or authenticated admin page
- Replacing leaderboard semantics
- Backfilling historical rows beyond safe defaults in migration

## Migration Strategy

- Add `traffic_source` columns with default `player` so existing production rows
  remain analyzable without a separate data migration.
- Use `NOT NULL` plus a check constraint to prevent unclassified future rows.
- Keep the query backward-compatible with existing rows through the migration
  default.

## Verification Design

- Unit tests prove the DB inspector retries expected transient connection errors.
- Storage tests prove `traffic_source` is written and read correctly.
- Route/integration tests prove automated flows can mark rows as `automated`.
- Read-only SQL inspection proves the admin query returns player-only aggregates.
- Existing `make test` and focused integration checks remain green.

## Follow-up PR

A separate PR will implement full gameplay lifecycle telemetry (`started`,
`completed`, `abandoned`, and richer admin analytics) in a dedicated events flow.
