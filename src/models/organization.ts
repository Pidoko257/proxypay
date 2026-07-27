import { pool, queryRead, queryWrite } from "../config/database";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended" | "deleted";
  settings: Record<string, unknown>;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationAuditLog {
  id: string;
  organizationId: string;
  action: string;
  performedBy: string;
  details: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export class OrganizationModel {
  async findAll(
    page: number = 1,
    limit: number = 10,
    search: string | undefined,
  ): Promise<{ data: Organization[]; pagination: { total: number; page: number; limit: number; totalPages: number } }> {
    const offset = (page - 1) * limit;

    let query = "SELECT * FROM organizations";
    const params: unknown[] = [];
    let paramIndex = 0;

    if (search) {
      paramIndex += 1;
      query += ` WHERE name ILIKE $${paramIndex} OR slug ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
    }

    query += " ORDER BY created_at DESC";

    const countQuery = query.replace(/^SELECT \*$/, "SELECT COUNT(*) as total");
    const countResult = await queryRead(countQuery, params);
    const total = parseInt(countResult.rows[0]?.total, 10) || 0;

    paramIndex += 1;
    query += ` LIMIT $${paramIndex}`;
    paramIndex += 1;
    query += ` OFFSET $${paramIndex}`;
    params.push(limit, offset);

    const result = await queryRead(query, params);

    const data = result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      settings: row.settings || {},
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findById(id: string): Promise<Organization | null> {
    const result = await queryRead("SELECT * FROM organizations WHERE id = $1", [id]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      settings: row.settings || {},
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async findBySlug(slug: string): Promise<Organization | null> {
    const result = await queryRead("SELECT * FROM organizations WHERE slug = $1", [slug]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      settings: row.settings || {},
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async updateStatus(
    id: string,
    status: "active" | "suspended" | "deleted",
    performedBy: string,
    reason: string,
    ipAddress: string | undefined,
    userAgent: string | undefined,
  ): Promise<Organization | null> {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const current = await this.findById(id);
      if (!current) {
        await client.query("ROLLBACK");
        return null;
      }

      const updateQuery = "UPDATE organizations SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *";
      const result = await client.query(updateQuery, [status, id]);

      if (result.rows.length === 0) {
        await client.query("ROLLBACK");
        return null;
      }

      const auditQuery = `
        INSERT INTO organization_audit_logs (organization_id, action, performed_by, details, ip_address, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6)
      `;
      await client.query(auditQuery, [
        id,
        `ORG_${status.toUpperCase()}`,
        performedBy,
        JSON.stringify({ reason, previousStatus: current.status }),
        ipAddress || null,
        userAgent || null,
      ]);

      await client.query("COMMIT");

      const row = result.rows[0];
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
        settings: row.settings || {},
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteOrganization(id: string, performedBy: string): Promise<void> {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const auditQuery = `
        INSERT INTO organization_audit_logs (organization_id, action, performed_by, details)
        VALUES ($1, 'ORG_DELETE', $2, $3)
      `;
      await client.query(auditQuery, [id, performedBy, JSON.stringify({ deletedAt: new Date().toISOString() })]);

      await client.query("DELETE FROM organization_audit_logs WHERE organization_id = $1", [id]);
      await client.query("DELETE FROM api_keys WHERE organization_id = $1", [id]);
      await client.query("DELETE FROM organizations WHERE id = $1", [id]);

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async suspendApiKeys(organizationId: string): Promise<void> {
    await queryWrite(
      "UPDATE api_keys SET is_active = false WHERE organization_id = $1",
      [organizationId],
    );
  }

  async getApiKeys(organizationId: string): Promise<unknown[]> {
    const result = await queryRead(
      "SELECT id, key, is_active, scopes, permissions, created_at FROM api_keys WHERE organization_id = $1",
      [organizationId],
    );
    return result.rows;
  }

  async logAuditEvent(
    organizationId: string,
    action: string,
    performedBy: string,
    details: Record<string, unknown>,
    ipAddress: string | undefined,
    userAgent: string | undefined,
  ): Promise<void> {
    await queryWrite(
      `INSERT INTO organization_audit_logs (organization_id, action, performed_by, details, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [organizationId, action, performedBy, JSON.stringify(details), ipAddress || null, userAgent || null],
    );
  }
}