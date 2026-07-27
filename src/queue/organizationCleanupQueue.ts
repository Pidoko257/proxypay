import { rabbitMQManager, EXCHANGES, ROUTING_KEYS } from "./rabbitmq";

export const ORGANIZATION_CLEANUP_QUEUE_NAME = "organization-cleanup";

export interface OrganizationCleanupJobData {
  organizationId: string;
  performedBy: string;
  email: string;
  organizationName: string;
}

export async function addOrganizationCleanupJob(
  organizationId: string,
  performedBy: string,
  email?: string,
  organizationName?: string,
) {
  const data: OrganizationCleanupJobData = {
    organizationId,
    performedBy,
    email: email || "",
    organizationName: organizationName || "",
  };

  await rabbitMQManager.publish(
    EXCHANGES.ORGANIZATIONS,
    ROUTING_KEYS.ORGANIZATION_CLEANUP,
    data,
  );

  console.log(`[Queue] Added organization cleanup job: ${organizationId}`);
  return { id: organizationId };
}

export async function processOrganizationCleanup(
  data: OrganizationCleanupJobData,
) {
  const { organizationId, performedBy, email, organizationName } = data;

  try {
    const { pool } = await import("../config/database");

    await pool.query("BEGIN");

    await pool.query("DELETE FROM organization_audit_logs WHERE organization_id = $1", [
      organizationId,
    ]);

    await pool.query("DELETE FROM api_keys WHERE organization_id = $1", [
      organizationId,
    ]);

    await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]);

    await pool.query("COMMIT");

    console.log(`[OrganizationCleanup] Completed cleanup for org ${organizationId}`);

    if (email) {
      const { emailService } = await import("../services/email");
      await emailService.sendEmail({
        to: email,
        templateId: process.env.SENDGRID_ORG_DELETION_TEMPLATE_ID || "",
        dynamicTemplateData: {
          organizationId,
          organizationName,
          performedBy,
          deletedAt: new Date().toISOString(),
          year: new Date().getFullYear(),
        },
      });
    }
  } catch (error) {
    console.error(
      `[OrganizationCleanup] Failed to cleanup org ${organizationId}:`,
      error,
    );
    throw error;
  }
}