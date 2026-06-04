import { beforeEach, describe, expect, it, vi } from "vitest";

const beginMock = vi.fn();
const commitMock = vi.fn();
const rollbackMock = vi.fn();
const queryMock = vi.fn();
const inputMock = vi.fn().mockReturnThis();

vi.mock("mssql", () => {
  class MockTransaction {
    constructor() {}
    begin = beginMock;
    commit = commitMock;
    rollback = rollbackMock;
  }

  class MockRequest {
    constructor() {}
    input = inputMock;
    query = queryMock;
  }

  return {
    default: {
      Transaction: MockTransaction,
      Request: MockRequest,
      ISOLATION_LEVEL: {
        SERIALIZABLE: "SERIALIZABLE",
      },
    },
  };
});

describe("MssqlAnonymousTrialStore locking", () => {
  beforeEach(() => {
    vi.resetModules();
    beginMock.mockReset().mockResolvedValue(undefined);
    commitMock.mockReset().mockResolvedValue(undefined);
    rollbackMock.mockReset().mockResolvedValue(undefined);
    inputMock.mockReset().mockReturnThis();
    queryMock.mockReset();
  });

  it("uses serializable isolation and locking reads when reserving claim keys", async () => {
    queryMock
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ recordset: [] });

    const { MssqlAnonymousTrialStore } = await import("./mssql-anonymous-trial-store");
    const store = new MssqlAnonymousTrialStore({} as never);

    await store.reserveClaimKeys(
      ["claim-a", "claim-b"],
      {
        claimKey: "claim-a",
        createdAt: 1000,
        expiresAt: 2000,
      }
    );

    expect(beginMock).toHaveBeenCalledWith("SERIALIZABLE");
    expect(queryMock.mock.calls[0][0]).toContain("WITH (UPDLOCK, HOLDLOCK)");
  });
});
