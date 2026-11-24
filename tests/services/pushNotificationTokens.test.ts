import { pushNotificationService, PushTokenModel } from "../../src/services/push";
import { pool } from "../../src/config/database";

describe("Push notification expired device token handling", () => {
  describe("isInvalidTokenError", () => {
    it("identifies FCM token expired and unregistered error codes", () => {
      expect(
        pushNotificationService.isInvalidTokenError({ code: "messaging/token-expired" })
      ).toBe(true);

      expect(
        pushNotificationService.isInvalidTokenError({
          code: "messaging/registration-token-not-registered",
        })
      ).toBe(true);

      expect(
        pushNotificationService.isInvalidTokenError({ code: "messaging/invalid-registration-token" })
      ).toBe(true);

      expect(
        pushNotificationService.isInvalidTokenError({ code: "UNREGISTERED" })
      ).toBe(true);
    });

    it("identifies APNs bad device token errors", () => {
      expect(
        pushNotificationService.isInvalidTokenError({ code: "BadDeviceToken" })
      ).toBe(true);

      expect(
        pushNotificationService.isInvalidTokenError({
          message: "APNS device token not set before attempting to send Apple Push Notification",
        })
      ).toBe(true);
    });

    it("identifies descriptive expired error messages", () => {
      expect(
        pushNotificationService.isInvalidTokenError({ message: "The device token has expired" })
      ).toBe(true);

      expect(
        pushNotificationService.isInvalidTokenError({
          error: { message: "The registration token is not a valid FCM registration token" },
        })
      ).toBe(true);
    });

    it("returns false for network, timeout, or server errors", () => {
      expect(
        pushNotificationService.isInvalidTokenError({ code: "messaging/server-unavailable" })
      ).toBe(false);

      expect(
        pushNotificationService.isInvalidTokenError({ code: "ECONNRESET" })
      ).toBe(false);

      expect(
        pushNotificationService.isInvalidTokenError(null)
      ).toBe(false);
    });
  });

  describe("PushTokenModel token cleanup", () => {
    let tokenModel: PushTokenModel;

    beforeEach(() => {
      tokenModel = new PushTokenModel();
      jest.spyOn(pool, "query").mockResolvedValue({ rowCount: 5, rows: [{ id: "1" }] } as any);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("cleans up tokens older than configured retention days", async () => {
      const pruned = await tokenModel.cleanupOldTokens(30);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INTERVAL"),
        [30]
      );
      expect(pruned).toBe(5);
    });

    it("batch deletes multiple expired tokens", async () => {
      const deletedCount = await tokenModel.deleteTokens(["tok_1", "tok_2", "tok_3"]);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE token = ANY($1::text[])"),
        [["tok_1", "tok_2", "tok_3"]]
      );
      expect(deletedCount).toBe(5);
    });

    it("returns 0 if deleteTokens is called with empty array", async () => {
      const deleted = await tokenModel.deleteTokens([]);
      expect(deleted).toBe(0);
      expect(pool.query).not.toHaveBeenCalled();
    });
  });
});
