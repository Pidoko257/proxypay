import { queryRead, queryWrite } from "../config/database";
import { emailService } from "../services/email";

const EXPIRY_REMINDER_DAYS = 30;
const KYC_VALIDITY_YEARS = 1;

export async function runKYCExpiryJob(): Promise<{
  remindersSent: number;
  expiredCount: number;
}> {
  const now = new Date();
  let remindersSent = 0;
  let expiredCount = 0;

  // 1. Find KYC records expiring within 30 days (kyc_approved_at + 1 year)
  const expiringResult = await queryRead(
    `SELECT u.id, u.email, u.kyc_approved_at 
     FROM users u 
     WHERE u.kyc_level = $1 
     AND u.kyc_approved_at IS NOT NULL
     AND u.kyc_approved_at + INTERVAL '${KYC_VALIDITY_YEARS} years' - NOW() <= INTERVAL '${EXPIRY_REMINDER_DAYS} days'
     AND u.kyc_approved_at + INTERVAL '${KYC_VALIDITY_YEARS} years' > NOW()`,
    ["full"]
  );

  for (const user of expiringResult.rows) {
    if (user.email) {
      const expiryDate = new Date(user.kyc_approved_at);
      expiryDate.setFullYear(expiryDate.getFullYear() + KYC_VALIDITY_YEARS);
      const daysUntilExpiry = Math.ceil(
        (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );

      await emailService.sendEmail({
        to: user.email,
        templateId: process.env.SENDGRID_KYC_EXPIRY_TEMPLATE_ID || "",
        dynamicTemplateData: {
          daysUntilExpiry,
          expiryDate: expiryDate.toLocaleDateString(),
          reverifyUrl: `${process.env.APP_URL || "https://app.proxypay.com"}/kyc/reverify`,
          locale: "en",
          year: now.getFullYear(),
        },
      });

      remindersSent++;
      console.log(`[KYC Expiry Job] Sent reminder to user ${user.id} for expiry in ${daysUntilExpiry} days`);
    }
  }

  // 2. Find and expire KYC records past expiry (kyc_approved_at + 1 year < now)
  const expiredResult = await queryRead(
    `SELECT u.id, u.email, u.kyc_approved_at
     FROM users u 
     WHERE u.kyc_level = $1 
     AND u.kyc_approved_at IS NOT NULL
     AND u.kyc_approved_at + INTERVAL '${KYC_VALIDITY_YEARS} years' < NOW()`,
    ["full"]
  );

  for (const user of expiredResult.rows) {
    // Downgrade to BASIC tier
    await queryWrite(
      `UPDATE users 
       SET kyc_level = $1, 
           kyc_expired_at = NOW(),
           updated_at = NOW() 
       WHERE id = $2`,
      ["basic", user.id]
    );

    if (user.email) {
      await emailService.sendEmail({
        to: user.email,
        templateId: process.env.SENDGRID_KYC_EXPIRED_TEMPLATE_ID || "",
        dynamicTemplateData: {
          expiredDate: new Date(user.kyc_approved_at).toLocaleDateString(),
          reverifyUrl: `${process.env.APP_URL || "https://app.proxypay.com"}/kyc/reverify`,
          locale: "en",
          year: now.getFullYear(),
        },
      });

      console.log(`[KYC Expiry Job] Expired KYC for user ${user.id}`);
    }
    expiredCount++;
  }

  return { remindersSent, expiredCount };
}