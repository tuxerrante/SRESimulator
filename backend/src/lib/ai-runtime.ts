import { assertAiReadyForRuntime, getAiReadiness } from "./ai-config";
import { getProviderAdapter } from "./ai-providers";
import { isAiGlobalBudgetEnabled } from "./ai-budget";
import {
  AiReasoningExhaustedError,
  AiReasoningRetryEvent,
} from "./ai-providers/types";
import type { AiRoute } from "./token-logger";

// The transports, the abort/retry helpers and the error classes live in
// ./ai-providers. This module stays the single import surface the routes and
// the tests use: re-exporting rather than relocating keeps `instanceof` checks
// at every call site pointing at the same class objects.
export {
  AiQuotaExhaustedError,
  AiReasoningExhaustedError,
  AiReasoningRetryEvent,
  AiThrottledError,
} from "./ai-providers/types";
export type {
  AiCompactionMeta,
  AiTextMessage,
  AiTextRequest,
} from "./ai-providers/types";

import type { AiTextRequest } from "./ai-providers/types";

export async function generateAiText(request: AiTextRequest): Promise<string> {
  const readiness = assertAiReadyForRuntime();
  const provider = getProviderAdapter(readiness.provider);
  try {
    return await provider.generate(request);
  } catch (error) {
    if (error instanceof AiReasoningExhaustedError) {
      console.warn("[ai-runtime] Reasoning exhausted budget, retrying with reasoning_effort=low");
      return provider.generate({
        ...request,
        _reasoningEffortOverride: "low",
      });
    }
    throw error;
  }
}

let lastWarmupTime = 0;
const WARMUP_COOLDOWN_MS = 60000;

export function warmupAiModel(route: AiRoute = "command"): void {
  const now = Date.now();
  if (now - lastWarmupTime < WARMUP_COOLDOWN_MS) return;
  lastWarmupTime = now;
  const readiness = getAiReadiness();
  if (readiness.mockMode) return;
  // Keep-alive is worth a request only where it buys latency. Where it buys
  // nothing and spends a shared daily budget instead, the warmup is the wrong
  // trade: `/api/scenario` fires one on every catalog-served scenario, which
  // is precisely the path that needs no model at all.
  if (getProviderAdapter(readiness.provider).warmupCostsSharedQuota) return;
  // The same trade, reached from the other side. `warmupCostsSharedQuota` is
  // a property of the provider -- OpenRouter's free tier is capped per account
  // whether or not this deployment meters it. `AI_GLOBAL_BUDGET_ENABLED` is
  // the operator saying the account is capped, and it is accepted on Azure and
  // Vertex too. A keep-alive ping is fire-and-forget by design: nothing here
  // can be refused, and charging it would let a warmup spend the slot a
  // player's next request needed. So an opted-in deployment does not warm up,
  // and the budget's promise -- no provider traffic outside the cap -- holds
  // for every provider rather than only the one it was written for.
  if (isAiGlobalBudgetEnabled()) return;

  generateAiText({
    system: "You are a keep-alive bot. Respond with 'ping'.",
    messages: [{ role: "user", content: "ping" }],
    maxTokens: 50,
    route,
    _reasoningEffortOverride: "low",
  }).catch(() => {
    // Intentionally suppress the raw exception. E.g. 'e.message' may leak upstream 503 texts or IP addresses
    // which should not be emitted to stdout. Instead, use a sanitized invariant logging or just ignore it
    // since it's fire-and-forget. The structured telemetry logger in generateAiText will have captured the core
    // upstream request trace already.
    console.warn("[ai-runtime] Warmup request failed (ignored) due to transient AI error.");
  });
}

export async function* streamAiText(
  request: AiTextRequest
): AsyncGenerator<string | AiReasoningRetryEvent, void, void> {
  const readiness = assertAiReadyForRuntime();
  const provider = getProviderAdapter(readiness.provider);
  try {
    yield* provider.stream(request);
  } catch (error) {
    if (error instanceof AiReasoningExhaustedError) {
      console.warn("[ai-runtime] Reasoning exhausted budget, retrying with reasoning_effort=low");
      yield new AiReasoningRetryEvent();
      yield* provider.stream({
        ...request,
        _reasoningEffortOverride: "low",
      });
    } else {
      throw error;
    }
  }
}
