import { queryRead, queryWrite } from "../config/database";

export interface Organization {
  id: string;
  userId: string;
  name: string;
  businessName?: string | null;
  businessType?: string | null;
  registrationNumber?: string | null;
  taxId?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  website?: string | null;
  industry?: string | null;
  useCases: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface OnboardingProgress {
  id: string;
  userId: string;
  currentStep: number;
  step1CompletedAt: Date | null;
  step2CompletedAt: Date | null;
  step3CompletedAt: Date | null;
  step4CompletedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function mapOrganizationRow(row: any): Organization {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    businessName: row.business_name ?? null,
    businessType: row.business_type ?? null,
    registrationNumber: row.registration_number ?? null,
    taxId: row.tax_id ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    country: row.country ?? null,
    website: row.website ?? null,
    industry: row.industry ?? null,
    useCases: row.use_cases ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProgressRow(row: any): OnboardingProgress {
  return {
    id: row.id,
    userId: row.user_id,
    currentStep: row.current_step,
    step1CompletedAt: row.step_1_completed_at ?? null,
    step2CompletedAt: row.step_2_completed_at ?? null,
    step3CompletedAt: row.step_3_completed_at ?? null,
    step4CompletedAt: row.step_4_completed_at ?? null,
    completedAt: row.completed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class OrganizationModel {
  async findByUserId(userId: string): Promise<Organization | null> {
    const result = await queryRead(
      "SELECT * FROM organizations WHERE user_id = $1",
      [userId],
    );
    if (result.rows.length === 0) return null;
    return mapOrganizationRow(result.rows[0]);
  }

  async create(
    userId: string,
    name: string,
  ): Promise<Organization> {
    const result = await queryWrite(
      `INSERT INTO organizations (user_id, name)
       VALUES ($1, $2)
       RETURNING *`,
      [userId, name],
    );
    return mapOrganizationRow(result.rows[0]);
  }

  async updateBusinessInfo(
    userId: string,
    data: {
      businessName: string;
      businessType: string;
      registrationNumber?: string;
      taxId?: string;
      address?: string;
      city?: string;
      country?: string;
      website?: string;
      industry?: string;
    },
  ): Promise<Organization> {
    const result = await queryWrite(
      `UPDATE organizations
       SET business_name = $2,
           business_type = $3,
           registration_number = $4,
           tax_id = $5,
           address = $6,
           city = $7,
           country = $8,
           website = $9,
           industry = $10
       WHERE user_id = $1
       RETURNING *`,
      [
        userId,
        data.businessName,
        data.businessType,
        data.registrationNumber ?? null,
        data.taxId ?? null,
        data.address ?? null,
        data.city ?? null,
        data.country ?? null,
        data.website ?? null,
        data.industry ?? null,
      ],
    );
    if (result.rows.length === 0) {
      throw new Error(`Organization not found for user ${userId}`);
    }
    return mapOrganizationRow(result.rows[0]);
  }

  async updateUseCases(
    userId: string,
    useCases: string[],
  ): Promise<Organization> {
    const result = await queryWrite(
      `UPDATE organizations
       SET use_cases = $2
       WHERE user_id = $1
       RETURNING *`,
      [userId, useCases],
    );
    if (result.rows.length === 0) {
      throw new Error(`Organization not found for user ${userId}`);
    }
    return mapOrganizationRow(result.rows[0]);
  }

  async getOnboardingProgress(
    userId: string,
  ): Promise<OnboardingProgress | null> {
    const result = await queryRead(
      "SELECT * FROM onboarding_progress WHERE user_id = $1",
      [userId],
    );
    if (result.rows.length === 0) return null;
    return mapProgressRow(result.rows[0]);
  }

  async createOnboardingProgress(userId: string): Promise<OnboardingProgress> {
    const result = await queryWrite(
      `INSERT INTO onboarding_progress (user_id, current_step, step_1_completed_at)
       VALUES ($1, 1, CURRENT_TIMESTAMP)
       RETURNING *`,
      [userId],
    );
    return mapProgressRow(result.rows[0]);
  }

  async markStepCompleted(
    userId: string,
    step: number,
  ): Promise<OnboardingProgress> {
    const stepColumns: Record<number, string> = {
      1: "step_1_completed_at",
      2: "step_2_completed_at",
      3: "step_3_completed_at",
      4: "step_4_completed_at",
    };

    const column = stepColumns[step];
    if (!column) {
      throw new Error(`Invalid step: ${step}`);
    }

    const result = await queryWrite(
      `UPDATE onboarding_progress
       SET ${column} = CURRENT_TIMESTAMP,
           current_step = GREATEST(current_step, $2),
           completed_at = CASE
             WHEN step_1_completed_at IS NOT NULL
              AND step_2_completed_at IS NOT NULL
              AND step_3_completed_at IS NOT NULL
              AND step_4_completed_at IS NOT NULL
             THEN CURRENT_TIMESTAMP
             ELSE completed_at
           END
       WHERE user_id = $1
       RETURNING *`,
      [userId, step + 1],
    );

    if (result.rows.length === 0) {
      throw new Error(`Onboarding progress not found for user ${userId}`);
    }
    return mapProgressRow(result.rows[0]);
  }
}
