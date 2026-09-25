import type { AiRoute } from "../token-logger";

export interface AiTextMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiCompactionMeta {
  compacted: boolean;
  compactedMessageCount: number;
}

export interface AiTextRequest {
  system: string;
  messages: AiTextMessage[];
  maxTokens: number;
  route?: AiRoute;
  compactionMeta?: AiCompactionMeta;
  cacheKey?: string;
  signal?: AbortSignal;
  /** @internal Override reasoning_effort on retry. */
  _reasoningEffortOverride?: string;
  /**
   * @internal How many provider HTTP requests this logical call has issued.
   *
   * Carried on the request rather than in the transport, because the count
   * has to survive the `{ ...request }` spread `generateAiText` and
   * `streamAiText` retry through -- the spread copies it forward, which is
   * what makes that retry countable as part of the call that provoked it.
   * The route charges the shared budget for the first request before it calls
   * the provider; the transport charges every one after that. Left undefined
   * by every caller: the transport seeds it.
   */
  _providerRequestCount?: number;
}

export class AiThrottledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiThrottledError";
  }
}

/**
 * A budget the caller cannot wait out inside one request.
 *
 * Deliberately a subclass of AiThrottledError: every existing catch site
 * (routes/scenario.ts, routes/command.ts, routes/chat.ts) already treats an
 * AiThrottledError as "degrade or 429", so subclassing keeps all of them
 * correct without an edit, and the sites that want the richer behaviour opt in
 * by testing for this class first.
 *
 * - `credits` — HTTP 402. The account is out of credit; nothing resets it on
 *   its own.
 * - `daily`  — HTTP 429 carrying a day-scoped cap. Retrying inside the request
 *   is pointless, so the transport must not spend its backoff budget on it.
 */
export class AiQuotaExhaustedError extends AiThrottledError {
  constructor(
    readonly scope: "daily" | "credits",
    message: string,
  ) {
    super(message);
    this.name = "AiQuotaExhaustedError";
  }
}

export class AiReasoningExhaustedError extends Error {
  constructor(providerLabel = "Azure OpenAI") {
    super(`${providerLabel} consumed completion tokens for reasoning without output text`);
    this.name = "AiReasoningExhaustedError";
  }
}

export class AiReasoningRetryEvent {
  readonly type = "reasoning-retry" as const;
}

/**
 * Everything the OpenAI-compatible transport needs to talk to one provider for
 * one request. Built per request, because the model/deployment is route-scoped.
 */
export interface OpenAiCompatibleTarget {
  /** Provider name as it appears in thrown messages and warnings. */
  providerLabel: string;
  /** Fully-resolved chat/completions URL. */
  url: string;
  headers: Record<string, string>;
  /**
   * Model identity. Sent in the body under `modelField` when that is set, and
   * always reported as the `deployment` tag in token telemetry.
   */
  modelValue: string;
  /** Body key carrying `modelValue`, or null when the URL already names it. */
  modelField: string | null;
  /** What `modelValue` is called in operator-facing warnings. */
  modelNoun?: string;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  /**
   * Whether a rejection naming the token field may be retried under the other
   * name. Azure needs it (the field changed with the API version); providers
   * with one stable spelling must not, or an unrelated error mentioning the
   * field turns into a silent second request.
   */
  allowMaxTokensFieldFallback: boolean;
  supportsReasoningEffort: boolean;
  supportsPromptCacheKey: boolean;
  /** Called when the provider rejects reasoning_effort, so the caller can cache it. */
  onReasoningEffortRejected?: () => void;
  /**
   * Map a failing response to a specific error. Returning null falls through to
   * the transport's default handling.
   */
  classifyFailure?: (status: number, body: string) => Error | null;
  /**
   * Whether `classifyFailure` should also see the body of a 429. It costs a
   * body read the retry path does not otherwise need, so it is opt-in: only
   * providers that encode a cap the request cannot wait out — OpenRouter's
   * day-scoped limit — need it, and for them skipping the backoff is the whole
   * point, because the retry budget is longer than the caller's timeout.
   */
  inspectThrottleBody?: boolean;
  /** Retried once with this target when `isFallbackTrigger` matches. */
  fallbackTarget?: OpenAiCompatibleTarget;
  isFallbackTrigger?: (error: unknown) => boolean;
}
