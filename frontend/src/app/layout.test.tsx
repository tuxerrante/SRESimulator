import { Children, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-geist-sans" }),
  Geist_Mono: () => ({ variable: "font-geist-mono" }),
}));

vi.mock("next/server", () => ({
  connection: vi.fn(),
}));

vi.mock("next/script", () => ({
  default: function MockNextScript() {
    return null;
  },
}));

function asElementWithProps(
  node: ReactNode,
): ReactElement<Record<string, unknown>> | null {
  return isValidElement(node)
    ? (node as ReactElement<Record<string, unknown>>)
    : null;
}

describe("RootLayout", () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SENTRY_ENABLED: "true",
      NEXT_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      NEXT_PUBLIC_SENTRY_ENVIRONMENT: "production",
      NEXT_PUBLIC_SENTRY_RELEASE: "frontend@1.2.3",
      NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE: "0.25",
      NEXT_PUBLIC_SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE: "1",
    };

    const nextServer = await import("next/server");
    vi.mocked(nextServer.connection).mockResolvedValue(undefined);
  });

  it("reads runtime config on the server and passes it into the browser bootstrap", async () => {
    const nextServer = await import("next/server");
    const { default: RootLayout } = await import("./layout");

    const tree = await RootLayout({
      children: <div>hello runtime</div>,
    });

    expect(nextServer.connection).toHaveBeenCalledTimes(1);

    const htmlElement = asElementWithProps(tree);
    const htmlChildren = Children.toArray(
      (htmlElement?.props.children ?? null) as ReactNode,
    );
    const body = htmlChildren.find((child) => {
      const element = asElementWithProps(child);
      return element?.type === "body";
    });

    expect(body).toBeTruthy();
    const bodyElement = asElementWithProps(body);
    const bodyChildren = Children.toArray(
      (bodyElement?.props.children ?? null) as ReactNode,
    );
    const script = bodyChildren.find(
      (child) => {
        const element = asElementWithProps(child);
        return (
          element?.props.id === "sentry-browser-runtime-config" &&
          element?.props.strategy === "beforeInteractive"
        );
      },
    );

    expect(script).toBeTruthy();
    const scriptElement = asElementWithProps(script);
    expect(String(scriptElement?.props.children ?? "")).toContain(
      "__SRESIM_SENTRY_BROWSER_CONFIG__",
    );
    expect(String(scriptElement?.props.children ?? "")).toContain(
      '"enabled":true',
    );
    expect(String(scriptElement?.props.children ?? "")).toContain(
      '"dsn":"https://public@example.ingest.sentry.io/1"',
    );
    expect(String(scriptElement?.props.children ?? "")).not.toContain("frontend@1.2.3");
    expect(String(scriptElement?.props.children ?? "")).not.toContain('"release"');
  });
});
