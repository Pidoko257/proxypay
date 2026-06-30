import { runKYCExpiryJob } from "../../jobs/kycExpiryJob";

describe("kycExpiryJob", () => {
  it("exports runKYCExpiryJob function", () => {
    expect(typeof runKYCExpiryJob).toBe("function");
  });
});