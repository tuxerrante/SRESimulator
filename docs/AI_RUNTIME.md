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

This reduces per-request input tokens from ~32K to ~10K, enabling roughly
3x more concurrent players within the same Azure OpenAI TPM quota.

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
rate limit on the shared Azure OpenAI deployment. Per-route token
consumption measured empirically:

| Route | Tokens/request | Peak rate (1 user) | Peak TPM |
| ------- | --------------- | ------------------- | ---------- |
| Chat | ~16K | 2-3/min | ~48K |
| Command | ~4K | 1-2/min | ~8K |
| Scenario | ~2.3K | burst | ~2K |

For multi-user deployments, multiply the single-user peak (~50K TPM) by
the number of concurrent users and increase `aoai_capacity` accordingly.

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
