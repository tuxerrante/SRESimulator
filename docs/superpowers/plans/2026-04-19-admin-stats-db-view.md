# Admin Stats and DB Inspector Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live DB inspection resilient to Azure SQL cold resumes, add durable traffic-source filtering, and provide a quick player-only admin stats query for completion-rate reporting.

**Architecture:** Keep the current Makefile-first read-only inspection flow and use the existing SQL-backed persistence model. Extend the schema with a small `traffic_source` field, plumb it through the storage and route layer, and aggregate admin stats from `sessions` because it is the only table that represents one row per run.

**Tech Stack:** TypeScript, Node.js, Vitest, Express, Azure SQL, Make, OpenShift CLI

---

## Tasks

### Task 1: Harden `db-inspect-live` Against Azure SQL Cold Resumes

**Files:**

- Modify: `scripts/db-inspect.cjs`
- Test: `backend/src/lib/storage/mssql-stores.test.ts` or a new focused script test file if needed
- Reference: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Write the failing test for retryable SQL connection failure**

Create a focused test that simulates the first `pool.connect()` failing with a
transient timeout and the second attempt succeeding.

```ts
it("retries read-only inspection when the first SQL connect times out", async () => {
  const connect = vi.fn()
    .mockRejectedValueOnce(new Error("Failed to connect to host:1433 in 15000ms"))
    .mockResolvedValue(undefined);
  // Assert the inspector logic attempts connect twice and then proceeds.
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd backend && npm run test:coverage -- --run src/lib/db-inspect.test.ts
```

Expected: the new test fails because the retry path does not exist yet.

- [ ] **Step 3: Add minimal retry logic to the inspector**

Implement a tiny helper in `scripts/db-inspect.cjs` that retries only read-only
inspection connection setup for known transient timeout/resume errors.

```js
async function connectWithRetry(pool, attempts) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await pool.connect();
      return;
    } catch (error) {
      if (attempt === attempts || !isRetryableConnectError(error)) throw error;
      await sleep(attempt * 2000);
    }
  }
}
```

- [ ] **Step 4: Re-run the focused test and verify GREEN**

Run:

```bash
cd backend && npm run test:coverage -- --run src/lib/db-inspect.test.ts
```

Expected: the new test passes.

- [ ] **Step 5: Document the retry behavior**

Add a short note to `docs/ARCHITECTURE.md` explaining that `db-inspect-live`
may wait and retry during Azure SQL serverless resume instead of failing on the
first timeout.

### Task 2: Add Durable Traffic-Source Classification

**Files:**

- Modify: `backend/src/lib/storage/migrations/002_traffic_source.sql`
- Modify: `backend/src/lib/storage/types.ts`
- Modify: `backend/src/lib/storage/mssql-session-store.ts`
- Modify: `backend/src/lib/storage/mssql-leaderboard-store.ts`
- Modify: `backend/src/lib/storage/mssql-metrics-store.ts`
- Modify: `backend/src/lib/storage/mssql-stores.test.ts`
- Modify: `backend/src/integration/mssql-stores.integration.test.ts`

- [ ] **Step 1: Write failing storage tests for `traffic_source`**

Add tests that expect inserts to bind a `trafficSource` input and persisted rows
to default or return `player`.

```ts
expect(req.input).toHaveBeenCalledWith("trafficSource", "player");
```

```ts
expect(record.trafficSource).toBe("automated");
```

- [ ] **Step 2: Run the targeted storage tests and verify RED**

Run:

```bash
cd backend && npm run test:coverage -- --run src/lib/storage/mssql-stores.test.ts src/integration/mssql-stores.integration.test.ts
```

Expected: the new assertions fail because the schema and types do not support
`trafficSource` yet.

- [ ] **Step 3: Extend schema and types with minimal production-safe defaults**

Update SQL tables and TypeScript types.

```sql
traffic_source VARCHAR(16) NOT NULL DEFAULT 'player'
  CHECK (traffic_source IN ('player', 'automated'))
```

```ts
export type TrafficSource = "player" | "automated";
```

- [ ] **Step 4: Plumb `trafficSource` through MSSQL stores**

Ensure session creation, leaderboard insert/upsert, and gameplay metrics insert
all write the field with default `player`.

```ts
.input("trafficSource", entry.trafficSource ?? "player")
```

- [ ] **Step 5: Re-run the targeted storage tests and verify GREEN**

Run:

```bash
cd backend && npm run test:coverage -- --run src/lib/storage/mssql-stores.test.ts src/integration/mssql-stores.integration.test.ts
```

Expected: the updated tests pass.

### Task 3: Mark Automated Test Traffic and Preserve Player Defaults

**Files:**

- Modify: `backend/src/routes/scenario.ts`
- Modify: `backend/src/routes/scores.ts`
- Modify: `backend/src/integration/game-flow.test.ts`
- Modify: `backend/src/routes/scores.test.ts`
- Modify: `shared/types/leaderboard.ts`

- [ ] **Step 1: Write failing route/integration tests for automated traffic**

Add one server-side test path that sends an internal automation marker and
expects persisted rows to carry `trafficSource = 'automated'`.

```ts
expect(saved.trafficSource).toBe("automated");
```

- [ ] **Step 2: Run the focused route tests and verify RED**

Run:

```bash
cd backend && npm run test:coverage -- --run src/routes/scores.test.ts src/integration/game-flow.test.ts
```

Expected: the new automated-traffic assertions fail.

- [ ] **Step 3: Add minimal server-side plumbing for source classification**

Keep player traffic as the default. Allow test callers to provide a controlled
server-side override used by tests and future seeded traffic.

```ts
const trafficSource = req.get("x-traffic-source") === "automated"
  ? "automated"
  : "player";
```

- [ ] **Step 4: Re-run the focused route tests and verify GREEN**

Run:

```bash
cd backend && npm run test:coverage -- --run src/routes/scores.test.ts src/integration/game-flow.test.ts
```

Expected: the route and integration tests pass with player traffic unchanged.

### Task 4: Add the Quick Admin Stats Query and Docs

**Files:**

- Modify: `scripts/db-inspect.cjs`
- Modify: `Makefile`
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Write the failing test for player-only aggregation SQL generation**

Add a test around the query text or extracted helper so the admin stats query is
explicit and excludes automated traffic.

```ts
expect(adminStatsSql).toContain("WHERE traffic_source = 'player'");
expect(adminStatsSql).toContain("SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END)");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd backend && npm run test:coverage -- --run src/lib/db-inspect.test.ts
```

Expected: the admin-query test fails because no helper/query exists yet.

- [ ] **Step 3: Implement the admin query in the read-only inspector path**

Expose a canned query mode so the operator can request completion metrics without
typing the full SQL each time.

```sql
SELECT
  difficulty,
  COUNT(*) AS attempts,
  SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) AS completions,
  CAST(100.0 * SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0) AS DECIMAL(5,2)) AS completion_pct
FROM sessions
WHERE traffic_source = 'player'
GROUP BY difficulty
ORDER BY difficulty;
```

- [ ] **Step 4: Add a Makefile alias and documentation**

Document a quick command such as:

```bash
make db-admin-stats NS=sre-simulator
```

or, if a new target is unnecessary, document the exact `SQL=... make
db-inspect-live` invocation in `docs/ARCHITECTURE.md`.

- [ ] **Step 5: Re-run the focused test and verify GREEN**

Run:

```bash
cd backend && npm run test:coverage -- --run src/lib/db-inspect.test.ts
```

Expected: the new query test passes.

### Task 5: Full Verification

**Files:**

- Reference: `Makefile`
- Reference: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Run repository validation**

Run:

```bash
make validate
```

Expected: exit code `0`.

- [ ] **Step 2: Run repository tests**

Run:

```bash
make test
```

Expected: exit code `0`.

- [ ] **Step 3: Run integration tests**

Run:

```bash
make test-integration
```

Expected: exit code `0`.

- [ ] **Step 4: Run the read-only admin stats query against the deployed backend**

Run:

```bash
make db-inspect-live NS="sre-simulator"
```

Then run the quick stats command or documented custom query and confirm the
result excludes automated traffic rows.
