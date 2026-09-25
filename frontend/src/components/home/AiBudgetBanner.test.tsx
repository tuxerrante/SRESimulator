import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AiBudgetBanner, type AiBudgetSnapshot } from "./AiBudgetBanner";

function makeSnapshot(overrides: Partial<AiBudgetSnapshot> = {}): AiBudgetSnapshot {
  return {
    enabled: true,
    dailyLimit: 1000,
    dailyRemaining: 1000,
    minuteLimit: 20,
    minuteRemaining: 20,
    degraded: false,
    exhaustedBehaviour: "simulated",
    resetAt: null,
    upstream: null,
    ...overrides,
  };
}

describe("AiBudgetBanner", () => {
  afterEach(() => {
    cleanup();
  });

  it("says nothing while the budget is healthy", () => {
    const { container } = render(<AiBudgetBanner snapshot={makeSnapshot()} />);

    expect(container.firstChild).toBeNull();
  });

  it("says nothing before the snapshot has loaded", () => {
    const { container } = render(<AiBudgetBanner snapshot={null} />);

    expect(container.firstChild).toBeNull();
  });

  it("stays hidden on a provider with no shared daily cap", () => {
    const { container } = render(
      <AiBudgetBanner snapshot={makeSnapshot({ enabled: false, dailyRemaining: 0, degraded: true })} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("warns once the day's shared requests are nearly gone", () => {
    render(<AiBudgetBanner snapshot={makeSnapshot({ dailyRemaining: 120 })} />);

    expect(screen.getByRole("status").textContent).toContain("120 of 1000 requests left today");
  });

  it("explains simulated answers once the budget is spent", () => {
    render(
      <AiBudgetBanner
        snapshot={makeSnapshot({ dailyRemaining: 0, degraded: true, resetAt: "2026-09-19T00:00:00.000Z" })}
      />,
    );

    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("answers are simulated");
    expect(text).toContain("Everything else still works");
  });

  it("does not promise simulated answers when the deployment rejects instead", () => {
    // AI_GLOBAL_DAILY_EXHAUSTED_MODE=reject and AI_DEGRADE_ON_QUOTA_EXHAUSTED=false
    // both answer gameplay 429. Telling that player their answers are merely
    // simulated sends them to retry something that cannot succeed.
    render(
      <AiBudgetBanner
        snapshot={makeSnapshot({
          dailyRemaining: 0,
          degraded: true,
          exhaustedBehaviour: "rejected",
          resetAt: "2026-09-19T00:00:00.000Z",
        })}
      />,
    );

    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("AI replies are unavailable");
    expect(text).not.toContain("answers are simulated");
  });

  it("prefers the provider's own count over the local one", () => {
    render(
      <AiBudgetBanner
        snapshot={makeSnapshot({
          dailyRemaining: 1000,
          upstream: { dailyLimit: 50, dailyRemaining: 3 },
        })}
      />,
    );

    // The local counter only knows what this process served; the account is
    // shared, so a healthy local number can hide a spent account.
    expect(screen.getByRole("status").textContent).toContain("3 of 50 requests left today");
  });

  it("falls back to the local pair when only one upstream number arrived", () => {
    render(
      <AiBudgetBanner
        snapshot={makeSnapshot({
          dailyRemaining: 120,
          upstream: { dailyLimit: null, dailyRemaining: 3 },
        })}
      />,
    );

    // The two upstream numbers only mean something together. Pairing the
    // provider's remaining with the locally configured limit renders a
    // sentence that is confidently wrong -- "3 of 1000 requests left" against
    // an account whose real cap is 50 -- so an incomplete reading falls back
    // to the pair that is at least internally consistent.
    expect(screen.getByRole("status").textContent).toContain("120 of 1000 requests left today");
  });

  it("falls back to the local pair when only the upstream limit arrived", () => {
    render(
      <AiBudgetBanner
        snapshot={makeSnapshot({
          dailyRemaining: 120,
          upstream: { dailyLimit: 50, dailyRemaining: null },
        })}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("120 of 1000 requests left today");
  });

  it("omits the reset time rather than printing an invalid date", () => {
    render(
      <AiBudgetBanner snapshot={makeSnapshot({ dailyRemaining: 0, degraded: true, resetAt: "not-a-date" })} />,
    );

    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("answers are simulated.");
    expect(text).not.toContain("until");
  });
});
