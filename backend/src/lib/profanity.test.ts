import { describe, expect, it } from "vitest";
import { isCleanNickname } from "./profanity";

describe("profanity filter", () => {
  it("accepts clean nicknames", () => {
    expect(isCleanNickname("alice").clean).toBe(true);
    expect(isCleanNickname("Player123").clean).toBe(true);
    expect(isCleanNickname("SRE_Master").clean).toBe(true);
    expect(isCleanNickname("k8s-hero").clean).toBe(true);
  });

  it("does not false-positive on innocent words containing short blocklist substrings", () => {
    expect(isCleanNickname("classy").clean).toBe(true);
    expect(isCleanNickname("hello").clean).toBe(true);
    expect(isCleanNickname("analysis").clean).toBe(true);
    expect(isCleanNickname("peacock").clean).toBe(true);
    expect(isCleanNickname("scrapbook").clean).toBe(true);
    expect(isCleanNickname("document").clean).toBe(true);
    expect(isCleanNickname("raccoon").clean).toBe(true);
    expect(isCleanNickname("grape").clean).toBe(true);
  });

  it("rejects obvious profanity", () => {
    const result = isCleanNickname("fuck");
    expect(result.clean).toBe(false);
    expect(result.reason).toContain("inappropriate");
  });

  it("rejects profanity as substring", () => {
    expect(isCleanNickname("shithead99").clean).toBe(false);
    expect(isCleanNickname("xassholex").clean).toBe(false);
  });

  it("rejects leetspeak substitutions", () => {
    expect(isCleanNickname("sh1t").clean).toBe(false);
    expect(isCleanNickname("a$$").clean).toBe(false);
    expect(isCleanNickname("b1+ch").clean).toBe(false);
    expect(isCleanNickname("d1ck").clean).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isCleanNickname("FUCK").clean).toBe(false);
    expect(isCleanNickname("FuCk").clean).toBe(false);
  });

  it("strips non-alphanumeric characters during normalization", () => {
    expect(isCleanNickname("f-u-c-k").clean).toBe(false);
    expect(isCleanNickname("f.u.c.k").clean).toBe(false);
  });
});
