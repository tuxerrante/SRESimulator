import * as Sentry from "@sentry/nextjs";
import { shouldInitSentry } from "./src/lib/telemetry/bootstrap-config";

if (
  shouldInitSentry(
    process.env.NEXT_PUBLIC_SENTRY_ENABLED,
    process.env.NEXT_PUBLIC_SENTRY_DSN,
  )
) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "development",
    sendDefaultPii: false,
  });
}
