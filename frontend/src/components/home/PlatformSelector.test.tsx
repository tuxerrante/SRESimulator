import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformSelector } from "./PlatformSelector";

afterEach(() => {
  cleanup();
});

describe("PlatformSelector", () => {
  it("renders all supported gameplay platforms", () => {
    render(
      <PlatformSelector value="aro-classic" onChange={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: /ARO Classic/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /ARO HCP/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /AKS/i })).toBeDefined();
  });

  it("calls onChange with the chosen platform", () => {
    const onChange = vi.fn();
    render(
      <PlatformSelector value="aro-classic" onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /AKS/i }));

    expect(onChange).toHaveBeenCalledWith("aks");
  });
});
