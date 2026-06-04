# Gameplay Telemetry Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightweight abuse protection to gameplay telemetry by deduping repeated lifecycle writes per session and applying a dedicated limiter tuned for metrics traffic.

**Architecture:** Keep the AI quota limiter separate. Add a gameplay-specific limiter at the gameplay router, and add one metrics-store lookup for `sessionToken + lifecycleState` so the route can treat duplicate submissions as idempotent success without storing duplicate rows.

**Tech Stack:** TypeScript, Express, `express-rate-limit`, Vitest, JSON/MSSQL storage backends.

---

## Task 1: Plan the red tests

**Files:**

- Modify: `backend/src/routes/gameplay.test.ts`
- Modify: `backend/src/lib/storage/json-metrics-store.test.ts`
- Modify: `backend/src/lib/storage/mssql-stores.test.ts`

- [ ] **Step 1: Write the failing duplicate-route test**

```ts
it("POST /api/gameplay ignores duplicate lifecycle submissions for the same session", async () => {
  const token = await getSessionStore().create("easy", "The Sleeping Cluster");
  const app = createApp();

  await httpRequest(app, "POST", "/api/gameplay", {
    sessionToken: token,
    lifecycleState: "completed",
    nickname: "dedupe-player",
  });
  const duplicate = await httpRequest(app, "POST", "/api/gameplay", {
    sessionToken: token,
    lifecycleState: "completed",
    nickname: "dedupe-player",
  });

  expect(duplicate.status).toBe(202);
  expect((await getMetricsStore().getPlayerHistory("dedupe-player"))).toHaveLength(1);
});
```

- [ ] **Step 2: Write the failing limiter-route test**

```ts
it("POST /api/gameplay applies the gameplay telemetry rate limit", async () => {
  process.env.GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX = "2";
  const token = await getSessionStore().create("easy", "The Sleeping Cluster");
  const app = createApp();

  expect((await httpRequest(app, "POST", "/api/gameplay", { sessionToken: token, lifecycleState: "started" })).status).toBe(202);
  expect((await httpRequest(app, "POST", "/api/gameplay", { sessionToken: token, lifecycleState: "abandoned" })).status).toBe(202);
  expect((await httpRequest(app, "POST", "/api/gameplay", { sessionToken: token, lifecycleState: "completed" })).status).toBe(429);
});
```

- [ ] **Step 3: Write the failing JSON-store lookup test**

```ts
it("detects an existing lifecycle event for a session token", async () => {
  const store = new JsonMetricsStore();
  await store.recordGameplay({ sessionToken: "session-1", lifecycleState: "completed" });

  await expect(store.hasLifecycleEvent("session-1", "completed")).resolves.toBe(true);
  await expect(store.hasLifecycleEvent("session-1", "started")).resolves.toBe(false);
});
```

- [ ] **Step 4: Write the failing MSSQL-store lookup test**

```ts
it("hasLifecycleEvent() checks for a matching session token and lifecycle state", async () => {
  const { pool, req } = createMockPool([{ matched: 1 }]);
  const store = new MssqlMetricsStore(pool);

  await expect(store.hasLifecycleEvent("tok-1", "completed")).resolves.toBe(true);
  expect(req.input).toHaveBeenCalledWith("sessionToken", "tok-1");
  expect(req.input).toHaveBeenCalledWith("lifecycleState", "completed");
});
```

## Task 2: Implement the minimal production changes

**Files:**

- Modify: `backend/src/lib/storage/types.ts`
- Modify: `backend/src/lib/storage/json-metrics-store.ts`
- Modify: `backend/src/lib/storage/mssql-metrics-store.ts`
- Modify: `backend/src/lib/rate-limit.ts`
- Modify: `backend/src/routes/gameplay.ts`

- [ ] **Step 1: Add the metrics-store lookup interface**

```ts
hasLifecycleEvent(
  sessionToken: string,
  lifecycleState: GameplayLifecycleState,
): Promise<boolean>;
```

- [ ] **Step 2: Implement the JSON lookup**

```ts
async hasLifecycleEvent(sessionToken: string, lifecycleState: GameplayLifecycleState): Promise<boolean> {
  return this.records.some((record) =>
    record.sessionToken === sessionToken && record.lifecycleState === lifecycleState
  );
}
```

- [ ] **Step 3: Implement the MSSQL lookup**

```ts
const result = await this.pool.request()
  .input("sessionToken", sessionToken)
  .input("lifecycleState", lifecycleState)
  .query("SELECT TOP 1 1 AS matched FROM gameplay_metrics WHERE session_token = @sessionToken AND lifecycle_state = @lifecycleState");

return result.recordset.length > 0;
```

- [ ] **Step 4: Add a dedicated gameplay limiter**

```ts
export const gameplayTelemetryRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: Number.parseInt(process.env.GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX ?? "60", 10) || 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many gameplay telemetry events. Please slow down and try again shortly." },
  keyGenerator: ...
});
```

- [ ] **Step 5: Short-circuit duplicate gameplay writes in the route**

```ts
if (await getMetricsStore().hasLifecycleEvent(body.sessionToken, body.lifecycleState)) {
  res.status(202).json({ ok: true, deduped: true });
  return;
}
```

- [ ] **Step 6: Mount the limiter at the gameplay router**

```ts
gameplayRouter.use(gameplayTelemetryRateLimit);
```

## Task 3: Verify and close out

**Files:**

- Modify: `backend/src/routes/gameplay.test.ts`
- Modify: `backend/src/lib/storage/json-metrics-store.test.ts`
- Modify: `backend/src/lib/storage/mssql-stores.test.ts`

- [ ] **Step 1: Run the red tests and confirm they fail for the expected missing behavior**

Run: `npm --prefix backend test -- src/routes/gameplay.test.ts src/lib/storage/json-metrics-store.test.ts src/lib/storage/mssql-stores.test.ts`

Expected: route duplicate/rate-limit assertions fail and store lookup tests fail because `hasLifecycleEvent` does not exist yet.

- [ ] **Step 2: Re-run the same targeted tests after implementation**

Run: `npm --prefix backend test -- src/routes/gameplay.test.ts src/lib/storage/json-metrics-store.test.ts src/lib/storage/mssql-stores.test.ts`

Expected: PASS

- [ ] **Step 3: Run repository verification through Makefile targets**

Run: `make test`
Expected: PASS

Run: `make validate`
Expected: PASS
