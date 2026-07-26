import { pool } from "../config/database";
import { encrypt } from "../utils/encryption";
import { generateToken } from "../auth/jwt";
import { hashPassword } from "../utils/password";
import { OrganizationModel } from "../models/organization";
import type { Step1Input, Step2Input, Step3Input } from "../schemas/onboarding";

const organizationModel = new OrganizationModel();

export class OnboardingService {
  /**
   * Step 1: Create user account and organization
   */
  async createAccount(data: Step1Input): Promise<{
    user: { id: string; email: string };
    organization: { id: string; name: string };
    token: string;
  }> {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Create user
      const passwordHash = await hashPassword(data.password);
      const encryptedPhone = encrypt(data.phone_number, true);
      const encryptedEmail = encrypt(data.email);

      const roleResult = await client.query(
        "SELECT id FROM roles WHERE name = $1",
        ["user"],
      );
      if (roleResult.rows.length === 0) {
        throw new Error("Default role 'user' not found");
      }
      const roleId = roleResult.rows[0].id;

      const userResult = await client.query(
        `INSERT INTO users (phone_number, kyc_level, role_id, email)
         VALUES ($1, 'unverified', $2, $3)
         RETURNING id`,
        [encryptedPhone, roleId, encryptedEmail],
      );
      const userId = userResult.rows[0].id;

      // Create organization
      const orgResult = await client.query(
        `INSERT INTO organizations (user_id, name)
         VALUES ($1, $2)
         RETURNING id, name`,
        [userId, data.org_name],
      );

      // Create onboarding progress
      await client.query(
        `INSERT INTO onboarding_progress (user_id, current_step, step_1_completed_at)
         VALUES ($1, 1, CURRENT_TIMESTAMP)`,
        [userId],
      );

      await client.query("COMMIT");

      // Generate JWT
      const token = generateToken({
        userId,
        email: data.email,
        role: "user",
      });

      return {
        user: { id: userId, email: data.email },
        organization: {
          id: orgResult.rows[0].id,
          name: orgResult.rows[0].name,
        },
        token,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Step 2: Update business information
   */
  async updateBusinessInfo(
    userId: string,
    data: Step2Input,
  ): Promise<{ organization: any }> {
    // Verify step 1 is completed
    const progress = await organizationModel.getOnboardingProgress(userId);
    if (!progress || !progress.step1CompletedAt) {
      throw new Error("Step 1 must be completed before updating business info");
    }

    const organization = await organizationModel.updateBusinessInfo(userId, {
      businessName: data.business_name,
      businessType: data.business_type,
      registrationNumber: data.registration_number,
      taxId: data.tax_id,
      address: data.address,
      city: data.city,
      country: data.country,
      website: data.website,
      industry: data.industry,
    });

    await organizationModel.markStepCompleted(userId, 2);

    return { organization };
  }

  /**
   * Step 3: Set use cases
   */
  async setUseCases(
    userId: string,
    data: Step3Input,
  ): Promise<{ use_cases: string[] }> {
    // Verify step 2 is completed
    const progress = await organizationModel.getOnboardingProgress(userId);
    if (!progress || !progress.step2CompletedAt) {
      throw new Error("Step 2 must be completed before setting use cases");
    }

    const organization = await organizationModel.updateUseCases(
      userId,
      data.use_cases,
    );

    await organizationModel.markStepCompleted(userId, 3);

    return { use_cases: organization.useCases };
  }

  /**
   * Get onboarding status
   */
  async getStatus(userId: string): Promise<{
    current_step: number;
    completed: boolean;
    steps: {
      account: boolean;
      business: boolean;
      use_case: boolean;
      email_verification: boolean;
    };
    completed_at: Date | null;
  }> {
    const progress = await organizationModel.getOnboardingProgress(userId);

    if (!progress) {
      return {
        current_step: 0,
        completed: false,
        steps: {
          account: false,
          business: false,
          use_case: false,
          email_verification: false,
        },
        completed_at: null,
      };
    }

    return {
      current_step: progress.currentStep,
      completed: progress.completedAt !== null,
      steps: {
        account: progress.step1CompletedAt !== null,
        business: progress.step2CompletedAt !== null,
        use_case: progress.step3CompletedAt !== null,
        email_verification: progress.step4CompletedAt !== null,
      },
      completed_at: progress.completedAt,
    };
  }
}
