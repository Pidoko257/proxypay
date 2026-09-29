import { pool } from "../config/database";

export type ComplianceDocumentStatus = "draft" | "published" | "archived";

export interface ComplianceDocument {
  id: string;
  title: string;
  summary?: string | null;
  body: string;
  countryCode?: string | null;
  provider?: string | null;
  tags: string[];
  sourceUrl?: string | null;
  status: ComplianceDocumentStatus;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface ComplianceDocumentCreateInput {
  title: string;
  summary?: string | null;
  body: string;
  countryCode?: string | null;
  provider?: string | null;
  tags?: string[];
  sourceUrl?: string | null;
  status?: ComplianceDocumentStatus;
}

export interface ComplianceDocumentUpdateInput {
  title?: string;
  summary?: string | null;
  body?: string;
  countryCode?: string | null;
  provider?: string | null;
  tags?: string[];
  sourceUrl?: string | null;
  status?: ComplianceDocumentStatus;
}

export interface ComplianceDocumentFilter {
  country?: string;
  provider?: string;
  tag?: string;
  status?: ComplianceDocumentStatus;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ComplianceDocumentListResult {
  documents: ComplianceDocument[];
  total: number;
}

export interface ComplianceDocumentFacets {
  countries: string[];
  providers: string[];
  tags: string[];
}

export interface ComplianceDocumentVersion {
  id: string;
  documentId: string;
  versionNumber: number;
  title: string;
  summary?: string | null;
  body: string;
  countryCode?: string | null;
  provider?: string | null;
  tags: string[];
  sourceUrl?: string | null;
  status: string;
  changeSummary?: string | null;
  createdBy?: string | null;
  createdAt: Date | string;
}

export interface ComplianceDocumentVersionCreateInput {
  title: string;
  summary?: string | null;
  body: string;
  countryCode?: string | null;
  provider?: string | null;
  tags?: string[];
  sourceUrl?: string | null;
  status: string;
}

const selectFields = `
  id,
  title,
  summary,
  body,
  country_code AS "countryCode",
  provider,
  tags,
  source_url AS "sourceUrl",
  status,
  created_by AS "createdBy",
  updated_by AS "updatedBy",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export class ComplianceDocumentModel {
  async create(
    input: ComplianceDocumentCreateInput,
    actorUserId?: string,
  ): Promise<ComplianceDocument> {
    const query = `
      INSERT INTO compliance_documents (
        title, summary, body, country_code, provider, tags, source_url, status, created_by, updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
      RETURNING ${selectFields}
    `;

    const result = await pool.query(query, [
      input.title,
      input.summary ?? null,
      input.body,
      input.countryCode ?? null,
      input.provider ?? null,
      input.tags ?? [],
      input.sourceUrl ?? null,
      input.status ?? "published",
      actorUserId ?? null,
    ]);

    return this.mapRow(result.rows[0]);
  }

  async list(
    filter: ComplianceDocumentFilter = {},
  ): Promise<ComplianceDocumentListResult> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filter.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filter.status);
    } else {
      conditions.push("status <> 'archived'");
    }

    if (filter.country) {
      conditions.push(`country_code = $${paramIndex++}`);
      params.push(filter.country);
    }

    if (filter.provider) {
      conditions.push(`LOWER(provider) = LOWER($${paramIndex++})`);
      params.push(filter.provider);
    }

    if (filter.tag) {
      conditions.push(`LOWER($${paramIndex++}) = ANY(tags)`);
      params.push(filter.tag);
    }

    if (filter.search) {
      conditions.push(`(
        title ILIKE $${paramIndex}
        OR summary ILIKE $${paramIndex}
        OR body ILIKE $${paramIndex}
        OR provider ILIKE $${paramIndex}
        OR array_to_string(tags, ' ') ILIKE $${paramIndex}
      )`);
      params.push(`%${filter.search}%`);
      paramIndex++;
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const countResult = await pool.query(
      `SELECT COUNT(*) AS count FROM compliance_documents ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0]?.count ?? "0", 10);
    const limit = filter.limit ?? 25;
    const offset = filter.offset ?? 0;

    const listResult = await pool.query(
      `
        SELECT ${selectFields}
        FROM compliance_documents
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `,
      [...params, limit, offset],
    );

    return {
      documents: listResult.rows.map((row) => this.mapRow(row)),
      total,
    };
  }

  async findById(id: string): Promise<ComplianceDocument | null> {
    const result = await pool.query(
      `
        SELECT ${selectFields}
        FROM compliance_documents
        WHERE id = $1
      `,
      [id],
    );

    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async update(
    id: string,
    input: ComplianceDocumentUpdateInput,
    actorUserId?: string,
  ): Promise<ComplianceDocument | null> {
    const fields: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    const addField = (column: string, value: unknown) => {
      fields.push(`${column} = $${paramIndex++}`);
      params.push(value);
    };

    if (Object.prototype.hasOwnProperty.call(input, "title"))
      addField("title", input.title);
    if (Object.prototype.hasOwnProperty.call(input, "summary"))
      addField("summary", input.summary ?? null);
    if (Object.prototype.hasOwnProperty.call(input, "body"))
      addField("body", input.body);
    if (Object.prototype.hasOwnProperty.call(input, "countryCode"))
      addField("country_code", input.countryCode ?? null);
    if (Object.prototype.hasOwnProperty.call(input, "provider"))
      addField("provider", input.provider ?? null);
    if (Object.prototype.hasOwnProperty.call(input, "tags"))
      addField("tags", input.tags ?? []);
    if (Object.prototype.hasOwnProperty.call(input, "sourceUrl"))
      addField("source_url", input.sourceUrl ?? null);
    if (Object.prototype.hasOwnProperty.call(input, "status"))
      addField("status", input.status);

    fields.push("updated_at = CURRENT_TIMESTAMP");
    fields.push(`updated_by = $${paramIndex++}`);
    params.push(actorUserId ?? null);
    params.push(id);

    const result = await pool.query(
      `
        UPDATE compliance_documents
        SET ${fields.join(", ")}
        WHERE id = $${paramIndex}
        RETURNING ${selectFields}
      `,
      params,
    );

    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async archive(
    id: string,
    actorUserId?: string,
  ): Promise<ComplianceDocument | null> {
    const result = await pool.query(
      `
        UPDATE compliance_documents
        SET status = 'archived', updated_at = CURRENT_TIMESTAMP, updated_by = $1
        WHERE id = $2
        RETURNING ${selectFields}
      `,
      [actorUserId ?? null, id],
    );

    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async getFacets(): Promise<ComplianceDocumentFacets> {
    const result = await pool.query(`
      SELECT
        ARRAY(
          SELECT DISTINCT country_code
          FROM compliance_documents
          WHERE country_code IS NOT NULL AND status <> 'archived'
          ORDER BY country_code
        ) AS countries,
        ARRAY(
          SELECT DISTINCT provider
          FROM compliance_documents
          WHERE provider IS NOT NULL AND status <> 'archived'
          ORDER BY provider
        ) AS providers,
        ARRAY(
          SELECT DISTINCT value
          FROM compliance_documents, unnest(tags) AS tag(value)
          WHERE status <> 'archived'
          ORDER BY value
        ) AS tags
    `);

    return {
      countries: result.rows[0]?.countries ?? [],
      providers: result.rows[0]?.providers ?? [],
      tags: result.rows[0]?.tags ?? [],
    };
  }

  /**
   * Snapshot the current document state as a new version row.
   * The version_number is automatically incremented (MAX + 1) per document.
   */
  async createVersion(
    documentId: string,
    input: ComplianceDocumentVersionCreateInput,
    changeSummary?: string,
    actorUserId?: string,
  ): Promise<ComplianceDocumentVersion> {
    const query = `
      INSERT INTO compliance_document_versions (
        document_id,
        version_number,
        title,
        summary,
        body,
        country_code,
        provider,
        tags,
        source_url,
        status,
        change_summary,
        created_by
      )
      SELECT
        $1,
        COALESCE((SELECT MAX(version_number) FROM compliance_document_versions WHERE document_id = $1), 0) + 1,
        $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      RETURNING
        id,
        document_id AS "documentId",
        version_number AS "versionNumber",
        title,
        summary,
        body,
        country_code AS "countryCode",
        provider,
        tags,
        source_url AS "sourceUrl",
        status,
        change_summary AS "changeSummary",
        created_by AS "createdBy",
        created_at AS "createdAt"
    `;

    const result = await pool.query(query, [
      documentId,
      input.title,
      input.summary ?? null,
      input.body,
      input.countryCode ?? null,
      input.provider ?? null,
      input.tags ?? [],
      input.sourceUrl ?? null,
      input.status,
      changeSummary ?? null,
      actorUserId ?? null,
    ]);

    return this.mapVersionRow(result.rows[0]);
  }

  /**
   * Return all versions for a document, newest first.
   */
  async listVersions(
    documentId: string,
  ): Promise<ComplianceDocumentVersion[]> {
    const result = await pool.query(
      `
        SELECT
          id,
          document_id AS "documentId",
          version_number AS "versionNumber",
          title,
          summary,
          body,
          country_code AS "countryCode",
          provider,
          tags,
          source_url AS "sourceUrl",
          status,
          change_summary AS "changeSummary",
          created_by AS "createdBy",
          created_at AS "createdAt"
        FROM compliance_document_versions
        WHERE document_id = $1
        ORDER BY version_number DESC
      `,
      [documentId],
    );

    return result.rows.map((row) => this.mapVersionRow(row));
  }

  /**
   * Return a specific version by document id + version number.
   */
  async findVersion(
    documentId: string,
    versionNumber: number,
  ): Promise<ComplianceDocumentVersion | null> {
    const result = await pool.query(
      `
        SELECT
          id,
          document_id AS "documentId",
          version_number AS "versionNumber",
          title,
          summary,
          body,
          country_code AS "countryCode",
          provider,
          tags,
          source_url AS "sourceUrl",
          status,
          change_summary AS "changeSummary",
          created_by AS "createdBy",
          created_at AS "createdAt"
        FROM compliance_document_versions
        WHERE document_id = $1
          AND version_number = $2
      `,
      [documentId, versionNumber],
    );

    return result.rows.length > 0 ? this.mapVersionRow(result.rows[0]) : null;
  }

  /**
   * Restore a document to the state captured in a prior version.
   * Creates a new version snapshot (so history is never lost) and then
   * overwrites the live document row.
   * Returns the restored document.
   */
  async restoreVersion(
    documentId: string,
    versionNumber: number,
    actorUserId?: string,
  ): Promise<ComplianceDocument | null> {
    const version = await this.findVersion(documentId, versionNumber);
    if (!version) {
      return null;
    }

    // Snapshot the current live document before overwriting
    const current = await this.findById(documentId);
    if (current) {
      await this.createVersion(
        documentId,
        {
          title: current.title,
          summary: current.summary,
          body: current.body,
          countryCode: current.countryCode,
          provider: current.provider,
          tags: current.tags,
          sourceUrl: current.sourceUrl,
          status: current.status,
        },
        `Auto-snapshot before restore to v${versionNumber}`,
        actorUserId,
      );
    }

    // Overwrite the live document with the version's content
    const restored = await this.update(
      documentId,
      {
        title: version.title,
        summary: version.summary,
        body: version.body,
        countryCode: version.countryCode,
        provider: version.provider,
        tags: version.tags,
        sourceUrl: version.sourceUrl,
        status: version.status as ComplianceDocumentStatus,
      },
      actorUserId,
    );

    return restored;
  }

  private mapVersionRow(row: any): ComplianceDocumentVersion {
    return {
      id: row.id,
      documentId: row.documentId ?? row.document_id,
      versionNumber: row.versionNumber ?? row.version_number,
      title: row.title,
      summary: row.summary ?? null,
      body: row.body,
      countryCode: row.countryCode ?? row.country_code ?? null,
      provider: row.provider ?? null,
      tags: row.tags ?? [],
      sourceUrl: row.sourceUrl ?? row.source_url ?? null,
      status: row.status,
      changeSummary: row.changeSummary ?? row.change_summary ?? null,
      createdBy: row.createdBy ?? row.created_by ?? null,
      createdAt: row.createdAt ?? row.created_at,
    };
  }

  private mapRow(row: any): ComplianceDocument {
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      body: row.body,
      countryCode: row.countryCode ?? row.country_code ?? null,
      provider: row.provider,
      tags: row.tags ?? [],
      sourceUrl: row.sourceUrl ?? row.source_url ?? null,
      status: row.status,
      createdBy: row.createdBy ?? row.created_by ?? null,
      updatedBy: row.updatedBy ?? row.updated_by ?? null,
      createdAt: row.createdAt ?? row.created_at,
      updatedAt: row.updatedAt ?? row.updated_at,
    };
  }
}
