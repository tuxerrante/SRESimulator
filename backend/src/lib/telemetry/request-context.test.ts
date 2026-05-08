import type { Request } from "express";
import { describe, expect, it } from "vitest";
import {
  ACTOR_REF_HEADER,
  GAME_SESSION_REF_HEADER,
  REQUEST_ID_HEADER,
} from "../../../../shared/telemetry/constants";
import { buildSentryRequestContext } from "./request-context";

function createRequest(headers: Record<string, string | undefined>): Request {
  return {
    method: "POST",
    path: "/api/scenario",
    baseUrl: "",
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

describe("buildSentryRequestContext", () => {
  it("keeps only safe request metadata and pseudonymous refs", () => {
    const request = createRequest({
      [REQUEST_ID_HEADER]: "3a8f6d6e-32ef-4a97-8891-0bc5987888f1",
      [ACTOR_REF_HEADER]: "2c9374a5-94f3-4c58-aab5-413f28643f03",
      [GAME_SESSION_REF_HEADER]: "4d2c91fa8e7b6a10",
      authorization: "Bearer secret",
      cookie: "session=secret",
    });

    expect(buildSentryRequestContext(request)).toEqual({
      tags: {
        feature: "scenario",
        requestId: "3a8f6d6e-32ef-4a97-8891-0bc5987888f1",
        actorRef: "2c9374a5-94f3-4c58-aab5-413f28643f03",
        gameSessionRef: "4d2c91fa8e7b6a10",
      },
      extra: {
        request: {
          method: "POST",
          route: "/api/scenario",
        },
      },
    });
  });

  it("drops malformed correlation headers instead of promoting them into tags", () => {
    const request = createRequest({
      [REQUEST_ID_HEADER]: "not-a-uuid",
      [ACTOR_REF_HEADER]: "12345678-1234-1234-1234-123456789012-extra",
      [GAME_SESSION_REF_HEADER]: "BADCAFE123456789",
    });

    expect(buildSentryRequestContext(request)).toEqual({
      tags: {
        feature: "scenario",
      },
      extra: {
        request: {
          method: "POST",
          route: "/api/scenario",
        },
      },
    });
  });

  it("keeps valid correlation tags while dropping oversized values", () => {
    const request = createRequest({
      [REQUEST_ID_HEADER]: "d0f6fcb3-e0c6-44ee-a764-785ee587d664",
      [ACTOR_REF_HEADER]: "f1d7c2ab-6a98-4ba1-8f7f-f61f28dbfc87xxxxxxxx",
      [GAME_SESSION_REF_HEADER]: "4d2c91fa8e7b6a10ff",
    });

    expect(buildSentryRequestContext(request)).toEqual({
      tags: {
        feature: "scenario",
        requestId: "d0f6fcb3-e0c6-44ee-a764-785ee587d664",
      },
      extra: {
        request: {
          method: "POST",
          route: "/api/scenario",
        },
      },
    });
  });

  it("uses the mounted route baseUrl for router-level captures", () => {
    const request = {
      method: "POST",
      path: "/",
      baseUrl: "/api/chat",
      get() {
        return undefined;
      },
    } as unknown as Request;

    expect(buildSentryRequestContext(request)).toEqual({
      tags: {
        feature: "chat",
      },
      extra: {
        request: {
          method: "POST",
          route: "/api/chat",
        },
      },
    });
  });
});
