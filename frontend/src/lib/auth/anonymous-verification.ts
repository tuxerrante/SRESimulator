interface AnonymousVerificationMessageOptions {
  turnstileConfigured: boolean;
  turnstileVerified: boolean;
}

export function getAnonymousVerificationMessage({
  turnstileConfigured,
  turnstileVerified,
}: AnonymousVerificationMessageOptions): string | null {
  if (!turnstileConfigured) {
    return "Anonymous guest mode is unavailable until Turnstile is configured.";
  }

  if (turnstileVerified) {
    return "Verification complete. You can start your anonymous Easy run.";
  }

  return null;
}
