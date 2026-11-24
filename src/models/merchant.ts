import { queryRead, queryWrite, pool } from "../config/database";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";

export interface Merchant {
  id: string;
  name: string;
  email: string;
  phoneNumber: string;
  businessName?: string;
  businessType?: string;
  taxId?: string;
  address?: string;
  city?: string;
  country: string;
  status: "pending" | "active" | "suspended" | "rejected";
  kycStatus: "not_started" | "in_progress" | "verified" | "rejected";
  invitationToken?: string;
  invitationSentAt?: Date;
  invitationAcceptedAt?: Date;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  // Hierarchy fields
  parentMerchantId: string | null;
  hierarchyLevel: number;
  hierarchyPath: string | null;
  maxSubAccounts: number;
}

export interface CreateSubAccountInput {
  name: string;
  email: string;
  phoneNumber: string;
  businessName?: string;
  businessType?: string;
  taxId?: string;
  address?: string;
  city?: string;
  country?: string;
  metadata?: Record<string, any>;
  maxSubAccounts?: number;
}

export interface HierarchyTreeNode extends Merchant {
  children: HierarchyTreeNode[];
}

export interface CreateMerchantInput {
  name: string;
  email: string;
  phoneNumber: string;
  businessName?: string;
  businessType?: string;
  taxId?: string;
  address?: string;
  city?: string;
  country?: string;
  metadata?: Record<string, any>;
}

export interface UpdateMerchantInput {
  name?: string;
  businessName?: string;
  businessType?: string;
  taxId?: string;
  address?: string;
  city?: string;
  country?: string;
  status?: "pending" | "active" | "suspended" | "rejected";
  kycStatus?: "not_started" | "in_progress" | "verified" | "rejected";
  metadata?: Record<string, any>;
}

export interface MerchantBatchJob {
  id: string;
  jobId: string;
  status: "pending" | "processing" | "completed" | "failed";
  totalRecords: number;
  processedRecords: number;
  succeededRecords: number;
  failedRecords: number;
  errors: Array<{ row: number; error: string; email?: string }>;
  createdBy: string;
  createdAt: Date;
  completedAt?: Date;
}

export class MerchantModel {
  async create(input: CreateMerchantInput): Promise<Merchant> {
    const id = uuidv4();
    const invitationToken = crypto.randomBytes(32).toString("hex");

    const query = `
      INSERT INTO merchants (
        id, name, email, phone_number, business_name, business_type,
        tax_id, address, city, country, status, kyc_status,
        invitation_token, invitation_sent_at, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 'not_started', $11, NULL, $12)
      RETURNING *
    `;

    const result = await queryWrite(query, [
      id,
      input.name,
      input.email.toLowerCase().trim(),
      input.phoneNumber,
      input.businessName || null,
      input.businessType || null,
      input.taxId || null,
      input.address || null,
      input.city || null,
      input.country || "CM",
      invitationToken,
      JSON.stringify(input.metadata || {}),
    ]);

    const row = result.rows[0];
    return this.mapRowToMerchant(row);
  }

  async createMany(
    merchants: CreateMerchantInput[],
    createdBy: string
  ): Promise<{ created: Merchant[]; errors: Array<{ row: number; error: string; email?: string }> }> {
    const created: Merchant[] = [];
    const errors: Array<{ row: number; error: string; email?: string }> = [];

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      for (let i = 0; i < merchants.length; i++) {
        const input = merchants[i];
        const rowNum = i + 2; // Row 1 is header, data starts at row 2

        try {
          const id = uuidv4();
          const invitationToken = crypto.randomBytes(32).toString("hex");

          const query = `
            INSERT INTO merchants (
              id, name, email, phone_number, business_name, business_type,
              tax_id, address, city, country, status, kyc_status,
              invitation_token, invitation_sent_at, metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 'not_started', $11, NULL, $12)
            RETURNING *
          `;

          const result = await client.query(query, [
            id,
            input.name,
            input.email.toLowerCase().trim(),
            input.phoneNumber,
            input.businessName || null,
            input.businessType || null,
            input.taxId || null,
            input.address || null,
            input.city || null,
            input.country || "CM",
            invitationToken,
            JSON.stringify(input.metadata || {}),
          ]);

          created.push(this.mapRowToMerchant(result.rows[0]));
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          errors.push({
            row: rowNum,
            error: errorMessage,
            email: input.email,
          });
        }
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return { created, errors };
  }

  async findById(id: string): Promise<Merchant | null> {
    const result = await queryRead("SELECT * FROM merchants WHERE id = $1", [id]);
    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  async findByEmail(email: string): Promise<Merchant | null> {
    const result = await queryRead("SELECT * FROM merchants WHERE email = $1", [email.toLowerCase().trim()]);
    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  async findByInvitationToken(token: string): Promise<Merchant | null> {
    const result = await queryRead("SELECT * FROM merchants WHERE invitation_token = $1", [token]);
    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  async update(id: string, input: UpdateMerchantInput): Promise<Merchant | null> {
    const sets: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      sets.push(`name = $${paramIndex++}`);
      values.push(input.name);
    }
    if (input.businessName !== undefined) {
      sets.push(`business_name = $${paramIndex++}`);
      values.push(input.businessName);
    }
    if (input.businessType !== undefined) {
      sets.push(`business_type = $${paramIndex++}`);
      values.push(input.businessType);
    }
    if (input.taxId !== undefined) {
      sets.push(`tax_id = $${paramIndex++}`);
      values.push(input.taxId);
    }
    if (input.address !== undefined) {
      sets.push(`address = $${paramIndex++}`);
      values.push(input.address);
    }
    if (input.city !== undefined) {
      sets.push(`city = $${paramIndex++}`);
      values.push(input.city);
    }
    if (input.country !== undefined) {
      sets.push(`country = $${paramIndex++}`);
      values.push(input.country);
    }
    if (input.status !== undefined) {
      sets.push(`status = $${paramIndex++}`);
      values.push(input.status);
    }
    if (input.kycStatus !== undefined) {
      sets.push(`kyc_status = $${paramIndex++}`);
      values.push(input.kycStatus);
    }
    if (input.metadata !== undefined) {
      sets.push(`metadata = $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(input.metadata));
    }

    if (sets.length === 0) {
      return this.findById(id);
    }

    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const query = `UPDATE merchants SET ${sets.join(", ")} WHERE id = $${paramIndex} RETURNING *`;
    const result = await queryWrite(query, values);

    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  async markInvitationSent(id: string): Promise<void> {
    await queryWrite(
      "UPDATE merchants SET invitation_sent_at = CURRENT_TIMESTAMP WHERE id = $1",
      [id]
    );
  }

  async acceptInvitation(id: string): Promise<Merchant | null> {
    const query = `
      UPDATE merchants 
      SET 
        invitation_accepted_at = CURRENT_TIMESTAMP,
        status = 'active',
        invitation_token = NULL
      WHERE id = $1
      RETURNING *
    `;

    const result = await queryWrite(query, [id]);
    if (result.rows.length === 0) return null;
    return this.mapRowToMerchant(result.rows[0]);
  }

  async list(options?: {
    page?: number;
    limit?: number;
    status?: string;
    kycStatus?: string;
  }): Promise<{ merchants: Merchant[]; total: number }> {
    const page = options?.page || 1;
    const limit = options?.limit || 50;
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (options?.status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(options.status);
    }
    if (options?.kycStatus) {
      conditions.push(`kyc_status = $${paramIndex++}`);
      values.push(options.kycStatus);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countQuery = `SELECT COUNT(*) as total FROM merchants ${whereClause}`;
    const countResult = await queryRead(countQuery, values);
    const total = parseInt(countResult.rows[0]?.total || "0", 10);

    const dataQuery = `
      SELECT * FROM merchants ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    values.push(limit, offset);

    const result = await queryRead(dataQuery, values);
    const merchants = result.rows.map((row: any) => this.mapRowToMerchant(row));

    return { merchants, total };
  }

  async getBatchJob(jobId: string): Promise<MerchantBatchJob | null> {
    const result = await queryRead(
      "SELECT * FROM merchant_batch_jobs WHERE job_id = $1",
      [jobId]
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      jobId: row.job_id,
      status: row.status,
      totalRecords: row.total_records,
      processedRecords: row.processed_records,
      succeededRecords: row.succeeded_records,
      failedRecords: row.failed_records,
      errors: row.errors || [],
      createdBy: row.created_by,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }

  async createBatchJob(
    jobId: string,
    totalRecords: number,
    createdBy: string
  ): Promise<MerchantBatchJob> {
    const id = uuidv4();
    const query = `
      INSERT INTO merchant_batch_jobs (
        id, job_id, status, total_records, processed_records,
        succeeded_records, failed_records, errors, created_by
      )
      VALUES ($1, $2, 'pending', $3, 0, 0, 0, '[]', $4)
      RETURNING *
    `;

    const result = await queryWrite(query, [id, jobId, totalRecords, createdBy]);
    const row = result.rows[0];

    return {
      id: row.id,
      jobId: row.job_id,
      status: row.status,
      totalRecords: row.total_records,
      processedRecords: row.processed_records,
      succeededRecords: row.succeeded_records,
      failedRecords: row.failed_records,
      errors: row.errors || [],
      createdBy: row.created_by,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }

  async updateBatchJob(
    jobId: string,
    updates: {
      status?: string;
      processedRecords?: number;
      succeededRecords?: number;
      failedRecords?: number;
      errors?: Array<{ row: number; error: string; email?: string }>;
      completedAt?: Date;
    }
  ): Promise<void> {
    const sets: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      sets.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }
    if (updates.processedRecords !== undefined) {
      sets.push(`processed_records = $${paramIndex++}`);
      values.push(updates.processedRecords);
    }
    if (updates.succeededRecords !== undefined) {
      sets.push(`succeeded_records = $${paramIndex++}`);
      values.push(updates.succeededRecords);
    }
    if (updates.failedRecords !== undefined) {
      sets.push(`failed_records = $${paramIndex++}`);
      values.push(updates.failedRecords);
    }
    if (updates.errors !== undefined) {
      sets.push(`errors = $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(updates.errors));
    }
    if (updates.completedAt !== undefined) {
      sets.push(`completed_at = $${paramIndex++}`);
      values.push(updates.completedAt);
    }

    if (sets.length === 0) return;

    values.push(jobId);
    const query = `UPDATE merchant_batch_jobs SET ${sets.join(", ")} WHERE job_id = $${paramIndex}`;
    await queryWrite(query, values);
  }

  // ---------------------------------------------------------------------------
  // Hierarchy methods
  // ---------------------------------------------------------------------------

  /**
   * Creates a sub-account under a parent merchant.
   * Sets hierarchy_level = parent.hierarchy_level + 1 and builds hierarchy_path.
   */
  async createSubAccount(
    parentId: string,
    input: CreateSubAccountInput
  ): Promise<Merchant> {
    const parent = await this.findById(parentId);
    if (!parent) {
      throw new Error(`Parent merchant ${parentId} not found`);
    }

    const id = uuidv4();
    const invitationToken = crypto.randomBytes(32).toString("hex");

    const hierarchyLevel = parent.hierarchyLevel + 1;
    // Build path: parent path (without trailing slash) + "/" + new id
    const parentPath = parent.hierarchyPath || `/${parent.id}`;
    const hierarchyPath = `${parentPath}/${id}`;

    const query = `
      INSERT INTO merchants (
        id, name, email, phone_number, business_name, business_type,
        tax_id, address, city, country, status, kyc_status,
        invitation_token, invitation_sent_at, metadata,
        parent_merchant_id, hierarchy_level, hierarchy_path, max_sub_accounts
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        'pending', 'not_started',
        $11, NULL, $12,
        $13, $14, $15, $16
      )
      RETURNING *
    `;

    const result = await queryWrite(query, [
      id,
      input.name,
      input.email.toLowerCase().trim(),
      input.phoneNumber,
      input.businessName || null,
      input.businessType || null,
      input.taxId || null,
      input.address || null,
      input.city || null,
      input.country || "CM",
      invitationToken,
      JSON.stringify(input.metadata || {}),
      parentId,
      hierarchyLevel,
      hierarchyPath,
      input.maxSubAccounts ?? 10,
    ]);

    return this.mapRowToMerchant(result.rows[0]);
  }

  /**
   * Lists direct sub-accounts (children) of a parent merchant.
   */
  async findSubAccounts(
    parentId: string,
    options?: { page?: number; limit?: number; status?: string }
  ): Promise<{ merchants: Merchant[]; total: number }> {
    const page = options?.page || 1;
    const limit = options?.limit || 50;
    const offset = (page - 1) * limit;

    const conditions: string[] = ["parent_merchant_id = $1"];
    const values: any[] = [parentId];
    let paramIndex = 2;

    if (options?.status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(options.status);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const countResult = await queryRead(
      `SELECT COUNT(*) as total FROM merchants ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0]?.total || "0", 10);

    const dataResult = await queryRead(
      `SELECT * FROM merchants ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, limit, offset]
    );

    return {
      merchants: dataResult.rows.map((row: any) => this.mapRowToMerchant(row)),
      total,
    };
  }

  /**
   * Returns all ancestors from the root down to (but not including) this merchant.
   * Uses the materialized hierarchy_path to find them in one query.
   */
  async findAncestors(merchantId: string): Promise<Merchant[]> {
    const merchant = await this.findById(merchantId);
    if (!merchant || !merchant.hierarchyPath) return [];

    // hierarchy_path looks like: /rootId/parentId/selfId
    // Ancestor IDs are all path segments except the last one (self)
    const segments = merchant.hierarchyPath.split("/").filter(Boolean);
    const ancestorIds = segments.slice(0, -1); // exclude self

    if (ancestorIds.length === 0) return [];

    // Fetch in a single query, then re-order to match path order
    const placeholders = ancestorIds.map((_: string, i: number) => `$${i + 1}`).join(", ");
    const result = await queryRead(
      `SELECT * FROM merchants WHERE id IN (${placeholders})`,
      ancestorIds
    );

    // Re-order to match path order (root → nearest parent)
    const byId = new Map<string, Merchant>(
      result.rows.map((row: any) => [row.id, this.mapRowToMerchant(row)])
    );
    return ancestorIds.map((id: string) => byId.get(id)).filter(Boolean) as Merchant[];
  }

  /**
   * Returns all descendants of a merchant using a prefix-match on hierarchy_path.
   */
  async findDescendants(merchantId: string): Promise<Merchant[]> {
    const merchant = await this.findById(merchantId);
    if (!merchant) return [];

    // All descendants have a hierarchy_path that starts with the merchant's path (or /{merchantId})
    const pathPrefix = merchant.hierarchyPath || `/${merchantId}`;

    const result = await queryRead(
      `SELECT * FROM merchants
       WHERE hierarchy_path LIKE $1
       ORDER BY hierarchy_level ASC, created_at ASC`,
      [`${pathPrefix}/%`]
    );

    return result.rows.map((row: any) => this.mapRowToMerchant(row));
  }

  /**
   * Returns a nested tree structure starting from a given merchant.
   */
  async getHierarchyTree(merchantId: string): Promise<HierarchyTreeNode | null> {
    const root = await this.findById(merchantId);
    if (!root) return null;

    const descendants = await this.findDescendants(merchantId);
    const all = [root, ...descendants];

    // Build a map for quick lookup
    const nodeMap = new Map<string, HierarchyTreeNode>(
      all.map((m) => [m.id, { ...m, children: [] }])
    );

    // Wire up parent → children
    for (const m of descendants) {
      if (m.parentMerchantId) {
        const parentNode = nodeMap.get(m.parentMerchantId);
        const selfNode = nodeMap.get(m.id);
        if (parentNode && selfNode) {
          parentNode.children.push(selfNode);
        }
      }
    }

    return nodeMap.get(merchantId) || null;
  }

  /**
   * Finds the root merchant of the hierarchy that contains the given merchant.
   */
  async getRootMerchant(merchantId: string): Promise<Merchant | null> {
    const merchant = await this.findById(merchantId);
    if (!merchant) return null;

    // A root merchant has no parent
    if (!merchant.parentMerchantId) return merchant;

    // Derive root from hierarchy_path: first segment after the leading slash
    if (merchant.hierarchyPath) {
      const segments = merchant.hierarchyPath.split("/").filter(Boolean);
      if (segments.length > 0) {
        return this.findById(segments[0]);
      }
    }

    // Fallback: walk up via parent_merchant_id
    return this.findById(merchant.parentMerchantId);
  }

  /**
   * Updates the hierarchy path and level of a merchant and all its descendants
   * when the merchant is re-parented.
   */
  async updateHierarchyPaths(
    merchantId: string,
    newParentId: string | null
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let newLevel = 0;
      let newPathPrefix = `/${merchantId}`;

      if (newParentId) {
        const newParentResult = await client.query(
          "SELECT hierarchy_level, hierarchy_path FROM merchants WHERE id = $1",
          [newParentId]
        );
        if (newParentResult.rows.length === 0) {
          throw new Error(`New parent merchant ${newParentId} not found`);
        }
        const np = newParentResult.rows[0];
        newLevel = (np.hierarchy_level || 0) + 1;
        const parentPath = np.hierarchy_path || `/${newParentId}`;
        newPathPrefix = `${parentPath}/${merchantId}`;
      }

      // Update the merchant itself
      await client.query(
        `UPDATE merchants
         SET parent_merchant_id = $1,
             hierarchy_level    = $2,
             hierarchy_path     = $3,
             updated_at         = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [newParentId, newLevel, newPathPrefix, merchantId]
      );

      // Fetch all descendants and rewrite their paths
      const descResult = await client.query(
        `SELECT id, hierarchy_path, hierarchy_level FROM merchants
         WHERE hierarchy_path LIKE $1
         ORDER BY hierarchy_level ASC`,
        [`${newPathPrefix}/%`]
      );

      // We need the OLD path of this merchant to do the substitution
      const oldMerchantResult = await client.query(
        "SELECT hierarchy_path FROM merchants WHERE id = $1",
        [merchantId]
      );
      const oldPath = oldMerchantResult.rows[0]?.hierarchy_path || `/${merchantId}`;

      for (const desc of descResult.rows) {
        const oldDescPath: string = desc.hierarchy_path || "";
        const updatedPath = oldDescPath.replace(oldPath, newPathPrefix);
        const levelDiff = newLevel - (oldMerchantResult.rows[0]?.hierarchy_level || 0);
        await client.query(
          `UPDATE merchants
           SET hierarchy_path  = $1,
               hierarchy_level = hierarchy_level + $2,
               updated_at      = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [updatedPath, levelDiff, desc.id]
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private mapRowToMerchant(row: any): Merchant {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phoneNumber: row.phone_number,
      businessName: row.business_name,
      businessType: row.business_type,
      taxId: row.tax_id,
      address: row.address,
      city: row.city,
      country: row.country,
      status: row.status,
      kycStatus: row.kyc_status,
      invitationToken: row.invitation_token,
      invitationSentAt: row.invitation_sent_at,
      invitationAcceptedAt: row.invitation_accepted_at,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // Hierarchy fields — default gracefully when columns don't exist yet
      parentMerchantId: row.parent_merchant_id ?? null,
      hierarchyLevel: row.hierarchy_level ?? 0,
      hierarchyPath: row.hierarchy_path ?? null,
      maxSubAccounts: row.max_sub_accounts ?? 10,
    };
  }
}