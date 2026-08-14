import { describe, expect, it } from "vitest";
import { humanizeExecutorError } from "./executorErrorMessage";

describe("humanizeExecutorError", () => {
  it("explains FdcHub submission failures without raw codes", () => {
    const text = humanizeExecutorError({
      code: "SUBMISSION_FAILED",
      message: "Failed to submit XRPPayment request to FdcHub",
      retryable: true,
    });
    expect(text).toMatch(/C2FLR|Data Connector/i);
    expect(text).not.toMatch(/^SUBMISSION_FAILED:/);
  });

  it("explains insufficient funds plainly", () => {
    const text = humanizeExecutorError({
      code: "SUBMISSION_FAILED",
      message: "Operator Coston2 wallet needs more C2FLR",
      retryable: true,
    });
    expect(text).toMatch(/faucet|C2FLR/i);
  });
});
