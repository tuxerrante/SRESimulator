import { NextResponse } from "next/server";
import {
  readFrontendSentryRuntimeConfig,
  serializeFrontendSentryRuntimeConfig,
} from "@/lib/telemetry/bootstrap-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  const config = readFrontendSentryRuntimeConfig(process.env);
  const script = serializeFrontendSentryRuntimeConfig(config);

  return new NextResponse(script, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
