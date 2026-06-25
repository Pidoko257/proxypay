import DataLoader from "dataloader";
import { queryRead } from "../config/database";

export interface OrganizationRecord {
  id: string;
  name: string;
}

export interface UserRecord {
  id: string;
  phoneNumber: string;
  kycLevel: string;
  status: string;
  createdAt: Date;
}

/**
 * Batch-load users by ID — single WHERE id = ANY($1) query per tick.
 */
function createUserByIdLoader(): DataLoader<string, UserRecord | null> {
  return new DataLoader<string, UserRecord | null>(async (ids) => {
    const result = await queryRead(
      `SELECT id, phone_number AS "phoneNumber", kyc_level AS "kycLevel", status, created_at AS "createdAt"
       FROM users WHERE id = ANY($1)`,
      [ids as string[]],
    );
    const byId = new Map<string, UserRecord>(result.rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id) ?? null);
  });
}

/**
 * Batch-load organizations by ID — backed by the merchants table.
 * Falls back to null if the ID is not found.
 */
function createOrganizationByIdLoader(): DataLoader<string, OrganizationRecord | null> {
  return new DataLoader<string, OrganizationRecord | null>(async (ids) => {
    const result = await queryRead(
      `SELECT id, business_name AS name FROM merchants WHERE id = ANY($1)`,
      [ids as string[]],
    );
    const byId = new Map<string, OrganizationRecord>(
      result.rows.map((r) => [r.id, { id: r.id, name: r.name }]),
    );
    return ids.map((id) => byId.get(id) ?? null);
  });
}

export interface DataLoaders {
  userById: DataLoader<string, UserRecord | null>;
  organizationById: DataLoader<string, OrganizationRecord | null>;
}

/** Create a fresh set of DataLoaders — must be called once per request. */
export function createDataLoaders(): DataLoaders {
  return {
    userById: createUserByIdLoader(),
    organizationById: createOrganizationByIdLoader(),
  };
}
