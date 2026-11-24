import { pool, queryRead, queryWrite } from "../config/database";
import {
  CursorPayload,
  buildCursorWhere,
  createCursor,
} from "../utils/pagination";

export type DestinationType = "phone" | "stellar";

export interface UserContact {
  id: string;
  userId: string;
  destinationType: DestinationType;
  destinationValue: string;
  nickname: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserContactInput {
  userId: string;
  destinationType: DestinationType;
  destinationValue: string;
  nickname: string;
}

export interface UpdateUserContactInput {
  destinationType?: DestinationType;
  destinationValue?: string;
  nickname?: string;
}

function mapRow(row: any): UserContact {
  return {
    id: row.id,
    userId: row.user_id,
    destinationType: row.destination_type,
    destinationValue: row.destination_value,
    nickname: row.nickname,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ContactModel {
  async create(input: CreateUserContactInput): Promise<UserContact> {
    const result = await queryWrite(
      `INSERT INTO user_contacts (user_id, destination_type, destination_value, nickname)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, destination_type, destination_value, nickname, created_at, updated_at`,
      [
        input.userId,
        input.destinationType,
        input.destinationValue,
        input.nickname,
      ],
    );

    return mapRow(result.rows[0]);
  }

  /**
   * List a user's contacts, newest first, with keyset (cursor) pagination.
   *
   * Ordering is stable: `ORDER BY created_at DESC, id DESC` with the cursor
   * predicate `(created_at, id) < (cursor.t, cursor.id)` so rows with equal
   * timestamps are never skipped or duplicated across pages.
   */
  async listByUser(
    userId: string,
    options?: { limit?: number; cursor?: CursorPayload; search?: string },
  ): Promise<{ contacts: UserContact[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
    const cursor = options?.cursor;
    const search = options?.search?.trim();

    let query = `SELECT id, user_id, destination_type, destination_value, nickname, created_at, updated_at
        FROM user_contacts
        WHERE user_id = $1`;
    const params: unknown[] = [userId];

    if (search) {
      query += ` AND (nickname ILIKE $${params.length + 1} OR destination_value ILIKE $${params.length + 2})`;
      params.push(`%${search}%`, `%${search}%`);
    }

    if (cursor) {
      const { clause, params: cursorParams } = buildCursorWhere(cursor, {
        column: "created_at",
        idColumn: "id",
        order: "desc",
        direction: "forward",
        paramOffset: params.length + 1,
      });
      query += ` AND ${clause}`;
      params.push(...cursorParams);
    }

    // Fetch one extra row — the overflow row signals there is a next page.
    query += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1}`;
    params.push(limit + 1);

    const result = await queryRead(query, params);
    const rows = result.rows.map(mapRow);
    const hasMore = rows.length > limit;
    const contacts = hasMore ? rows.slice(0, limit) : rows;

    const last = contacts[contacts.length - 1];
    const nextCursor =
      hasMore && last ? createCursor(last.createdAt, last.id) : undefined;
    return { contacts, nextCursor };
  }

  async findByIdForUser(
    id: string,
    userId: string,
  ): Promise<UserContact | null> {
    const result = await queryRead(
      `SELECT id, user_id, destination_type, destination_value, nickname, created_at, updated_at
       FROM user_contacts
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [id, userId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return mapRow(result.rows[0]);
  }

  async updateByIdForUser(
    id: string,
    userId: string,
    input: UpdateUserContactInput,
  ): Promise<UserContact | null> {
    const updates: string[] = [];
    const values: unknown[] = [id, userId];

    if (input.destinationType !== undefined) {
      values.push(input.destinationType);
      updates.push(`destination_type = $${values.length}`);
    }

    if (input.destinationValue !== undefined) {
      values.push(input.destinationValue);
      updates.push(`destination_value = $${values.length}`);
    }

    if (input.nickname !== undefined) {
      values.push(input.nickname);
      updates.push(`nickname = $${values.length}`);
    }

    if (updates.length === 0) {
      return this.findByIdForUser(id, userId);
    }

    const result = await queryWrite(
      `UPDATE user_contacts
       SET ${updates.join(", ")}
       WHERE id = $1 AND user_id = $2
       RETURNING id, user_id, destination_type, destination_value, nickname, created_at, updated_at`,
      values,
    );

    if (result.rows.length === 0) {
      return null;
    }

    return mapRow(result.rows[0]);
  }

  async deleteByIdForUser(id: string, userId: string): Promise<boolean> {
    const result = await queryWrite(
      `DELETE FROM user_contacts
       WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );

    return (result.rowCount ?? 0) > 0;
  }
}