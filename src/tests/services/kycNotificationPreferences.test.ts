import {
  kycNotificationService,
  KycNotificationService,
} from "../../services/kycNotificationService";

describe("KYC Status Notifications - Preference Respect (Issue #680)", () => {
  let service: KycNotificationService;

  beforeEach(() => {
    service = new KycNotificationService();
  });

  describe("Default Preferences", () => {
    it("delivers approved status notifications by default", async () => {
      const record = await service.notifyKycStatusChange({
        merchantId: "merch_101",
        applicantId: "app_101",
        previousStatus: "pending",
        newStatus: "approved",
      });

      expect(record.delivered).toBe(true);
      expect(record.deliverabilityStatus).toBe("delivered");
      expect(record.channels).toContain("webhook");
      expect(record.channels).toContain("email");
      expect(record.suppressionReason).toBeUndefined();
    });

    it("delivers rejected status notifications by default", async () => {
      const record = await service.notifyKycStatusChange({
        merchantId: "merch_102",
        applicantId: "app_102",
        previousStatus: "pending",
        newStatus: "rejected",
        rejectionReasons: ["blurry_photo", "name_mismatch"],
      });

      expect(record.delivered).toBe(true);
      expect(record.deliverabilityStatus).toBe("delivered");
      expect(record.rejectionReasons).toEqual(["blurry_photo", "name_mismatch"]);
    });

    it("suppresses pending status by default unless configured", async () => {
      const record = await service.notifyKycStatusChange({
        merchantId: "merch_103",
        applicantId: "app_103",
        previousStatus: "initiated",
        newStatus: "pending",
      });

      expect(record.delivered).toBe(false);
      expect(record.deliverabilityStatus).toBe("status_filtered");
      expect(record.suppressionReason).toContain("Notifications disabled for status: pending");
    });
  });

  describe("Global Opt-Out", () => {
    it("respects global opt-out preference and suppresses notifications", async () => {
      await service.optOut("user_optout_1");

      const record = await service.notifyKycStatusChange({
        merchantId: "merch_201",
        userId: "user_optout_1",
        applicantId: "app_201",
        previousStatus: "pending",
        newStatus: "approved",
      });

      expect(record.delivered).toBe(false);
      expect(record.deliverabilityStatus).toBe("opted_out");
      expect(record.suppressionReason).toBe("User has opted out of KYC notifications");
      expect(record.channels).toHaveLength(0);
    });

    it("allows re-opting in via optIn()", async () => {
      await service.optOut("user_optout_2");
      let record = await service.notifyKycStatusChange({
        merchantId: "merch_202",
        userId: "user_optout_2",
        applicantId: "app_202",
        previousStatus: "pending",
        newStatus: "approved",
      });
      expect(record.delivered).toBe(false);

      await service.optIn("user_optout_2");
      record = await service.notifyKycStatusChange({
        merchantId: "merch_202",
        userId: "user_optout_2",
        applicantId: "app_202",
        previousStatus: "pending",
        newStatus: "approved",
      });
      expect(record.delivered).toBe(true);
      expect(record.deliverabilityStatus).toBe("delivered");
    });
  });

  describe("Fine-Grained Status Preference Filtering", () => {
    it("suppresses approved notifications when notifyOnApproved is false", async () => {
      await service.setPreferences("user_fine_1", {
        notifyOnApproved: false,
        notifyOnRejected: true,
      });

      const record = await service.notifyKycStatusChange({
        merchantId: "merch_301",
        userId: "user_fine_1",
        applicantId: "app_301",
        previousStatus: "pending",
        newStatus: "approved",
      });

      expect(record.delivered).toBe(false);
      expect(record.deliverabilityStatus).toBe("status_filtered");
      expect(record.suppressionReason).toContain("Notifications disabled for status: approved");
    });

    it("suppresses rejected notifications when notifyOnRejected is false", async () => {
      await service.setPreferences("user_fine_2", {
        notifyOnApproved: true,
        notifyOnRejected: false,
      });

      const record = await service.notifyKycStatusChange({
        merchantId: "merch_302",
        userId: "user_fine_2",
        applicantId: "app_302",
        previousStatus: "pending",
        newStatus: "rejected",
      });

      expect(record.delivered).toBe(false);
      expect(record.deliverabilityStatus).toBe("status_filtered");
      expect(record.suppressionReason).toContain("Notifications disabled for status: rejected");
    });

    it("suppresses review notifications when notifyOnReview is false", async () => {
      await service.setPreferences("user_fine_3", {
        notifyOnReview: false,
      });

      const record = await service.notifyKycStatusChange({
        merchantId: "merch_303",
        userId: "user_fine_3",
        applicantId: "app_303",
        previousStatus: "pending",
        newStatus: "review",
      });

      expect(record.delivered).toBe(false);
      expect(record.deliverabilityStatus).toBe("status_filtered");
      expect(record.suppressionReason).toContain("Notifications disabled for status: review");
    });
  });

  describe("Channel Configuration & Deliverability", () => {
    it("records channels_disabled when all notification channels are switched off", async () => {
      await service.setPreferences("user_chan_1", {
        emailNotifications: false,
        webhookNotifications: false,
        smsNotifications: false,
      });

      const record = await service.notifyKycStatusChange({
        merchantId: "merch_401",
        userId: "user_chan_1",
        applicantId: "app_401",
        previousStatus: "pending",
        newStatus: "approved",
      });

      expect(record.delivered).toBe(false);
      expect(record.deliverabilityStatus).toBe("channels_disabled");
      expect(record.suppressionReason).toBe("All notification channels are disabled");
    });

    it("delivers solely to webhook when email is disabled", async () => {
      await service.setPreferences("user_chan_2", {
        emailNotifications: false,
        webhookNotifications: true,
      });

      const record = await service.notifyKycStatusChange({
        merchantId: "merch_402",
        userId: "user_chan_2",
        applicantId: "app_402",
        previousStatus: "pending",
        newStatus: "approved",
      });

      expect(record.delivered).toBe(true);
      expect(record.channels).toEqual(["webhook"]);
    });
  });

  describe("Deliverability Audit Trail & Metrics", () => {
    it("retrieves delivery history for a specific user or merchant", async () => {
      await service.notifyKycStatusChange({
        merchantId: "audit_merch",
        applicantId: "app_1",
        previousStatus: "pending",
        newStatus: "approved",
      });
      await service.notifyKycStatusChange({
        merchantId: "audit_merch",
        applicantId: "app_2",
        previousStatus: "initiated",
        newStatus: "pending",
      });

      const history = await service.getNotificationHistory("audit_merch");
      expect(history).toHaveLength(2);
      expect(history[0].delivered).toBe(true);
      expect(history[1].delivered).toBe(false);
    });

    it("computes accurate deliverability metrics breakdown", async () => {
      const targetUser = "metrics_user";
      // 1 delivered
      await service.notifyKycStatusChange({
        merchantId: "merch_m",
        userId: targetUser,
        applicantId: "app_m1",
        previousStatus: "pending",
        newStatus: "approved",
      });

      // 1 status filtered
      await service.notifyKycStatusChange({
        merchantId: "merch_m",
        userId: targetUser,
        applicantId: "app_m2",
        previousStatus: "initiated",
        newStatus: "pending",
      });

      // 1 opted out
      await service.optOut(targetUser);
      await service.notifyKycStatusChange({
        merchantId: "merch_m",
        userId: targetUser,
        applicantId: "app_m3",
        previousStatus: "pending",
        newStatus: "approved",
      });

      const metrics = service.getDeliverabilityMetrics(targetUser);
      expect(metrics.total).toBe(3);
      expect(metrics.delivered).toBe(1);
      expect(metrics.suppressed).toBe(2);
      expect(metrics.byStatus.delivered).toBe(1);
      expect(metrics.byStatus.status_filtered).toBe(1);
      expect(metrics.byStatus.opted_out).toBe(1);
    });
  });
});