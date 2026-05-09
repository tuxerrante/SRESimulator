import { Children, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-geist-sans" }),
  Geist_Mono: () => ({ variable: "font-geist-mono" }),
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
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("renders layout body children without telemetry bootstrap script", async () => {
    const { default: RootLayout } = await import("./layout");

    const tree = RootLayout({
      children: <div>hello runtime</div>,
    });

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
    expect(bodyChildren).toHaveLength(1);
    const contentElement = asElementWithProps(bodyChildren[0] ?? null);
    expect(contentElement?.type).toBe("div");
    expect(contentElement?.props.children).toBe("hello runtime");
  });
});
