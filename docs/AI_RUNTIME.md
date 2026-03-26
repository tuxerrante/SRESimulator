# AI Runtime Design

How the backend integrates with LLM providers, manages token budgets,
and stays resilient under concurrent load.

> Game mechanics, scoring, and UI architecture live in
> [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Provider Abstraction

The runtime supports two providers behind a single interface
(`backend/src/lib/ai-runtime.ts`):

| Provider | SDK / transport | Streaming |
| -------------- | ---------------------------------- | ------------------------------------ |
| **Vertex AI** | `@anthropic-ai/vertex-sdk` (Claude) | Native token-by-token via SDK |
| **Azure OpenAI** | REST `fetch` to chat completions | Pseudo-stream (single yield after full completion) |

`ai-config.ts` resolves the active provider from `AI_PROVIDER` and validates
credentials at startup. When `AI_STRICT_STARTUP` is true (default) and
validation fails, the process exits immediately. `AI_MOCK_MODE=true` bypasses
all live-provider requirements and returns deterministic fixtures.

### Reasoning-model compatibility

Azure OpenAI o-series models (o1, o3, o4-mini, etc.) differ from GPT-series
in two ways the runtime handles automatically:

- **temperature** is omitted (these models only support the default value of 1).
- **reasoning_effort** is sent (`low` / `medium` / `high`, configurable
  via `AI_REASONING_EFFORT`, default `medium`). This parameter is also
  sent to non-reasoning models when configured, as a forward-compatible
  hint that the API silently ignores if unsupported.

Detection is model-name based (`/^o\d/` or `/^gpt-5/`); no manual flag
is needed.

### Reasoning effort control

Azure OpenAI reasoning models share `max_completion_tokens` between
internal chain-of-thought and output text. The runtime sends
`reasoning_effort` (default `"medium"`, configurable via
`AI_REASONING_EFFORT`) to limit how many tokens the model spends
reasoning, reserving budget for actual output.

If the model exhausts its completion budget on reasoning
(`finish_reason: "length"` with reasoning tokens but no output), the
runtime retries once with `reasoning_effort: "low"`. During this retry
the frontend displays a "thinking deeper..." indicator.

### max_tokens vs max_completion_tokens

Some Azure API versions accept only `max_completion_tokens`, others only
`max_tokens`. The runtime tries `max_completion_tokens` first; if the API
rejects it, it retries with the legacy parameter automatically.

---

## Per-Route Deployments

Each API route can target a different Azure OpenAI deployment, allowing
cost and rate-limit isolation per workload. Resolution order:

1. Route-specific env var (e.g. `AI_AZURE_OPENAI_DEPLOYMENT_CHAT`)
2. Global fallback (`AI_AZURE_OPENAI_DEPLOYMENT`)

| Route | Env var override | Recommended model characteristics |
| ---------- | ----------------------------------------- | ----------------------------------- |
| `chat` | `AI_AZURE_OPENAI_DEPLOYMENT_CHAT` | High quality, streaming support |
| `command` | `AI_AZURE_OPENAI_DEPLOYMENT_COMMAND` | Fast, good at structured output |
| `scenario` | `AI_AZURE_OPENAI_DEPLOYMENT_SCENARIO` | Good at JSON generation |
| `probe` | `AI_AZURE_OPENAI_DEPLOYMENT_PROBE` | Cheapest/fastest available |

All overrides are optional. When unset, every route shares the global
deployment.

Deployments are **pre-provisioned** in Azure (via Terraform or portal).
The app never creates or modifies Azure resources at runtime. Separate
deployments give you independent TPM rate-limit pools, reducing the risk
that heavy chat usage throttles command execution.

---

## Knowledge Base Optimization

### Section-based retrieval

Instead of sending the entire knowledge base (~75 KB, ~18K tokens) on
every chat request, the backend parses KB files into sections at startup
and selects only the sections relevant to the current scenario and user
message. The investigation methodology (`sre-investigation-techniques.md`)
is always included. Relevant sections are selected by keyword scoring
against the scenario title, description, alerts, and the user's latest
message, capped at 8000 characters (~2K tokens).

This reduces per-request *prompt* tokens from ~32K to ~2.5K (measured on
gpt-5.2 with prompt caching active), enabling roughly 10x more concurrent
players within the same Azure OpenAI TPM quota.

### Prompt caching

Azure OpenAI automatically caches prompt token computations when the
first 1024+ tokens of a request are identical across requests. The system
prompt is structured with the static instruction block first (before
scenario and KB content) to maximize cache hits. The runtime also sends
`prompt_cache_key` keyed by scenario title so all players on the same
scenario share the same cache bucket. Cached tokens appear in the
`[token-usage]` log lines.

---

## Context Compaction

Long conversations are automatically compacted before each chat AI request.
The compactor (`backend/src/lib/context-compactor.ts`) measures token usage
and, when the total exceeds the budget, replaces older messages with a
structured summary while keeping the most recent messages verbatim.

### Token estimation

Token counts use the **o200k_base BPE tokenizer** (`gpt-tokenizer`)
for accurate estimation aligned with GPT-4o / GPT-5 models.

### Compaction budget

| Parameter | Env var | Default |
| --------------------- | ----------------------------- | ------- |
| Message token budget | `COMPACTION_TOKEN_BUDGET` | 12 000 |
| Retained tail messages | `COMPACTION_TAIL_MESSAGES` | 4 |

The effective budget subtracts the system-prompt token count, with a
floor of 2 000 tokens. When messages exceed this budget the head is
replaced with a synthetic summary; the tail messages are kept verbatim.

### Hybrid extraction strategy

Retained state is extracted from the compacted messages using two
complementary techniques:

| Technique | Used for | How |
| --------- | --------------------------------- | -------------------------------------------- |
| **Regex** | Phase markers, commands, scores, questions | Pattern matching on `[PHASE:…]`, fenced code blocks, `[SCORE:…]`, question marks |
| **NLP** | Facts, hypotheses | `compromise` library for sentence-level analysis using evidential-verb and hypothesis-term matching |

The NLP layer (`backend/src/lib/nlp-extract.ts`) uses the
[compromise](https://github.com/spencermountain/compromise) library to
split text into sentences and classify them:

- **Facts**: sentences containing evidential verbs
  (*confirmed*, *found*, *shows*, *indicates*, *reveals*, etc.)
- **Hypotheses**: sentences containing speculation terms
  (*think*, *suspect*, *might be*, *could be*, *root cause*, etc.)

### Retained-state schema

| Field | Cap | Description |
| ---------------------- | --- | --------------------------------------------------------- |
| `phase` | 1 | Current investigation phase |
| `knownFacts` | 15 | Evidence confirmed during the investigation |
| `hypotheses` | 5 | User theories about root cause |
| `mentionedCommands` | 20 | Commands suggested by DM or referenced by user |
| `unresolvedQuestions` | 10 | Questions the user asked that remain unanswered |
| `summaryOfDiscussion` | — | Scoring events and key discussion milestones |

All list fields are capped with a "keep newest" strategy. Questions are
auto-resolved (removed) when a subsequent fact shares ≥ 2 significant
keywords with the question.

### Command simulation prompt optimization

The command route (`/api/command`) builds system prompts from extracted
helper functions rather than inline string literals. Only the scenario
context and temporal rules are sent as dynamic content; the static
instruction layer is shared across calls.

### Fallback behavior

If Azure OpenAI returns empty text (e.g. reasoning tokens consumed the
entire completion budget), the backend:

1. Retries once with `reasoning_effort=low`.
2. If still empty, the command route falls back to deterministic mock output
   so gameplay continues unblocked.

---

## Token Observability

The backend logs token usage per route and per request
(`backend/src/lib/token-logger.ts`). Structured log lines include model,
deployment (Azure), prompt/completion/reasoning token counts, latency, and
whether compaction was applied:

```text
[token-usage] route=chat model=o4-mini deployment=o4mini-eastus prompt=3200 completion=450 reasoning=120 total=3650 latency=1200ms
[token-usage] route=chat model=o4-mini deployment=o4mini-eastus prompt=1800 completion=500 reasoning=0 total=2300 latency=900ms compacted=14msgs
```

### `GET /api/ai/token-metrics`

Returns per-route totals (requests, prompt/completion/reasoning tokens,
errors) and recent request entries. Protected by `x-ai-probe-token` header
in production.

---

## Rate Limiting & Throttle Handling

### Client-side rate limiting

AI-backed routes (`/api/chat`, `/api/command`, `/api/scenario`) are rate-limited
at **15 req/min per IP** using `express-rate-limit`. This prevents a single
user from exhausting the shared AOAI TPM quota.

### Azure OpenAI 429 retries

When Azure returns HTTP 429 the backend retries with exponential backoff
and jitter (up to 3 attempts), respecting the `Retry-After` header. If all
retries are exhausted, the client receives a 429 with a user-friendly
message.

### AOAI capacity sizing

The `aoai_capacity` Terraform variable (default 80K TPM) controls the
rate limit on the shared Azure OpenAI deployment.

Per-request token consumption measured on gpt-5.2 (March 2026, with
section-based KB retrieval and prompt caching active):

| Route | Prompt tokens | Completion tokens | Reasoning tokens | Total |
| ------- | ------------- | ----------------- | ---------------- | ----- |
| Chat | ~2 500 | ~450 | ~70 | ~3 000 |
| Command | ~4 000 | ~200 | — | ~4 200 |
| Scenario | ~2 300 | ~800 | — | ~3 100 |
| Probe | 26 | 16 | 5 | 42 |

Prompt caching is highly effective: **~74 % of prompt tokens** served from
cache across 81 test requests. This reduces effective input compute
significantly.

For multi-user deployments, multiply per-request totals by expected
concurrent request rate and increase `aoai_capacity` accordingly.

---

## Concurrent Load Test Results (March 2026)

Tested against live ARO deployment with gpt-5.2, 80K TPM, single
deployment, 15 req/min/IP rate limit.

| Concurrent requests | Result | Latency range |
| ------------------- | ----------------------------------- | ------------- |
| 1 | 1/1 OK | ~10 s |
| 3 | 3/3 OK | 7–11 s |
| 5 | 5/5 OK | 7–15 s |
| 10 | 10/10 OK | 11–18 s |
| 15 | 15/15 OK | 8–12 s |
| 20 | 5 OK, 15 throttled (429) | 10–16 s |

All integration tests pass against the live environment (SSE integrity,
session isolation, rate-limit enforcement, token-metrics recording).

---

## Known Limitations

### Single-IP rate limit affects all concurrent players behind NAT/proxy

The 15 req/min/IP rate limit applies per source IP. When multiple
players share an IP (corporate proxy, NAT, OpenShift router), they
collectively share the same rate-limit bucket. This means 2–3 active
players behind the same IP can trigger throttling during normal
gameplay (each player may send 4–6 requests per minute across chat,
command, and scenario routes).

**Mitigation:** Consider per-session rate limiting (e.g., keyed by a
session token or browser fingerprint) instead of per-IP.

### No server-side streaming for Azure OpenAI

Azure OpenAI chat completions are consumed as a single response and
then yielded as one SSE chunk. The frontend receives the full response
at once rather than token-by-token. This means:

- Users see no incremental output during the 7–18s response time.
- Long responses feel slower than they would with true streaming.

**Mitigation:** Implement Azure SSE streaming by consuming the
`stream: true` response incrementally.

### Reasoning models consume unpredictable token budgets

Reasoning models (o-series, gpt-5) allocate completion tokens between
internal chain-of-thought and output text. The split is non-deterministic:

- The same prompt may produce 30 reasoning tokens one time and 300 the
  next, causing variable latency (7–18s observed for the same request).
- With low `max_completion_tokens`, the model can exhaust the budget on
  reasoning without producing any output text. The retry with
  `reasoning_effort=low` mitigates this but adds latency.

### Token metrics are process-local and volatile

The in-memory ring buffer (200 entries) and route aggregates are lost on
pod restart. In a multi-replica deployment, each pod tracks its own
metrics independently — there is no aggregated view across replicas.

**Mitigation:** Export structured logs to an external observability stack
(e.g., Azure Monitor, Prometheus) for durable, cross-replica metrics.

### Leaderboard writes serialize on a single process

The leaderboard JSON file on PVC uses an in-process async mutex. In a
multi-replica deployment, concurrent writes from different pods can
race. The current architecture expects a single backend replica.

**Mitigation:** Move leaderboard storage to a shared database (e.g.,
CosmosDB, Redis) or use a distributed lock.

### Context compaction is best-effort

The hybrid regex + NLP extraction can miss facts or hypotheses that
don't match the expected sentence patterns. Compaction summaries may
lose nuance from the original conversation, potentially causing the
AI to repeat questions or miss context from earlier in the
investigation.

---

## Integration Testing

The `backend/src/integration/` directory contains tests that exercise the
full SSE chat pipeline under concurrent load. Tests run in two modes:

| Mode | Trigger | Backend | Assertions |
| -------- | ------------------------------ | --------------------------------- | ---------------------------------------- |
| **Local** | `npm run test:integration` | In-process Express with mock AI | All requests must succeed (200 + `[DONE]`) |
| **External** | `E2E_BACKEND_URL=… npm run test:integration` | Remote ARO deployment | Relaxed — allows 429/502/503 from gateway |

Test suites cover SSE stream integrity, session isolation, interleaving
prevention, rate-limit enforcement, and token-metrics recording.

---

## Environment Variable Reference

| Area | Variables |
| ---------------------- | ------------------------------------------- |
| Provider / model | `AI_PROVIDER`, `AI_MODEL`, `CLAUDE_MODEL` (legacy alias) |
| Mock / startup | `AI_MOCK_MODE`, `AI_STRICT_STARTUP` |
| Vertex | `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` |
| Azure OpenAI | `AI_AZURE_OPENAI_ENDPOINT`, `AI_AZURE_OPENAI_API_KEY`, `AI_AZURE_OPENAI_DEPLOYMENT`, `AI_AZURE_OPENAI_API_VERSION` |
| Per-route deployments | `AI_AZURE_OPENAI_DEPLOYMENT_CHAT`, `_COMMAND`, `_SCENARIO`, `_PROBE` |
| Reasoning | `AI_REASONING_EFFORT` (`low` / `medium` / `high`) |
| Compaction tuning | `COMPACTION_TOKEN_BUDGET`, `COMPACTION_TAIL_MESSAGES` |
| Production gates | `AI_LIVE_PROBE_TOKEN` |
