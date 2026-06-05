interface AnonymousVerificationMessageOptions {
  turnstileConfigured: boolean;
  turnstileVerified: boolean;
  turnstileTestMode: boolean;
}

export function getAnonymousVerificationMessage({
  turnstileConfigured,
  turnstileVerified,
  turnstileTestMode,
}: AnonymousVerificationMessageOptions): string | null {
  if (!turnstileConfigured) {
    return "Anonymous guest mode is unavailable until Turnstile is configured.";
  }

  if (turnstileVerified) {
    if (turnstileTestMode) {
      return "Local test verification complete. You can start your anonymous Easy run.";
    }
    return "Verification complete. You can start your anonymous Easy run.";
  }

  if (turnstileTestMode) {
    return "Local test mode is enabled. Use local verification to unlock anonymous Easy mode.";
  }

  return null;
}
