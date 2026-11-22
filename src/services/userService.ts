import { Pool, PoolClient } from "pg";
import { pool } from "../config/database";
import { encrypt, decrypt } from "../utils/encryption";
import { flushUserSessions } from "../config/redis";
import { UserModel } from "../models/users";
import { isValidMerchantMCC, requireValidMerchantMCC } from "../utils/merchantMcc";
import logger from "../utils/logger";

export interface User {
  id: string;
  phone_number: string;
  kyc_level: string;
  role_id?: string;
  role_name?: string;
  display_name?: string | null;
  mcc?: string | null;
  two_factor_secret?: string | null;
  two_factor_enabled?: boolean;
  two_factor_verified?: boolean;
  backup_codes?: string[] | null;
  is_active: boolean;
  deactivated_at?: Date | null;
  status: 'active' | 'frozen' | 'suspended';
  created_at: Date;
  updated_at: Date;
}

export interface CreateUserRequest {
  phone_number: string;
  kyc_level?: string;
  role_name?: string;
  mcc?: string;
  display_name?: string | null;
}

export interface LoginRequest {
  phone_number: string;
  // In a real app, you would have password or other auth method
}

/**
 * Get user by phone number with role information
 */
export async function getUserByPhoneNumber(
  phoneNumber: string,
): Promise<User | null> {
  const encryptedPhone = encrypt(phoneNumber, true);
  const query = `
    SELECT 
      u.id,
      u.phone_number,
      u.kyc_level,
      u.role_id,
      u.display_name,
      u.mcc,
      u.two_factor_secret,
      u.two_factor_enabled,
      u.two_factor_verified,
      u.backup_codes,
      u.is_active,
      u.deactivated_at,
      u.created_at,
      u.updated_at,
      r.name as role_name
    FROM users u
    LEFT JOIN roles r ON u.role_id = r.id
    WHERE u.phone_number = $1
  `;

  const result = await pool.query(query, [encryptedPhone]);
  if (result.rows.length === 0) return null;
  
  const row = result.rows[0];
  return {
    ...row,
    phone_number: decrypt(row.phone_number) as string,
    two_factor_secret: decrypt(row.two_factor_secret),
  };
}

/**
 * Get user by ID with role information
 */
export async function getUserById(userId: string): Promise<User | null> {
  const query = `
    SELECT 
      u.id,
      u.phone_number,
      u.kyc_level,
      u.role_id,
      u.display_name,
      u.mcc,
      u.two_factor_secret,
      u.two_factor_enabled,
      u.two_factor_verified,
      u.backup_codes,
      u.is_active,
      u.deactivated_at,
      u.created_at,
      u.updated_at,
      r.name as role_name
    FROM users u
    LEFT JOIN roles r ON u.role_id = r.id
    WHERE u.id = $1
  `;

  const result = await pool.query(query, [userId]);
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    ...row,
    phone_number: decrypt(row.phone_number) as string,
    two_factor_secret: decrypt(row.two_factor_secret),
  };
}

/**
 * Create a new user with optional role
 */
export async function createUser(userData: CreateUserRequest): Promise<User> {
  const {
    phone_number,
    kyc_level = "unverified",
    role_name = "user",
    mcc,
    display_name = null,
  } = userData;

  const merchantMcc = role_name === "merchant"
    ? requireValidMerchantMCC(mcc)
    : mcc
      ? isValidMerchantMCC(mcc)
        ? mcc.trim()
        : (() => { throw new Error(`Invalid Merchant MCC code '${mcc}'.`); })()
      : null;

  // Get role ID
  const roleQuery = "SELECT id FROM roles WHERE name = $1";
  const roleResult = await pool.query(roleQuery, [role_name]);

  if (roleResult.rows.length === 0) {
    throw new Error(`Role '${role_name}' not found`);
  }

  const roleId = roleResult.rows[0].id;

  const query = `
    INSERT INTO users (phone_number, kyc_level, role_id, mcc, display_name)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, phone_number, kyc_level, role_id, display_name, mcc, two_factor_secret, two_factor_enabled, two_factor_verified, backup_codes, is_active, deactivated_at, created_at, updated_at
  `;

  const encryptedPhone = encrypt(phone_number, true);
  const result = await pool.query(query, [
    encryptedPhone,
    kyc_level,
    roleId,
    merchantMcc,
    display_name,
  ]);
  const row = result.rows[0];

  const user = {
    ...row,
    phone_number: decrypt(row.phone_number) as string,
    two_factor_secret: decrypt(row.two_factor_secret),
    role_name,
    display_name: row.display_name ?? null,
    mcc: row.mcc ?? null,
  };

  return user;
}

/**
 * Update user role
 */
export async function updateUserRole(
  userId: string,
  roleName: string,
): Promise<User> {
  // Get role ID
  const roleQuery = "SELECT id FROM roles WHERE name = $1";
  const roleResult = await pool.query(roleQuery, [roleName]);

  if (roleResult.rows.length === 0) {
    throw new Error(`Role '${roleName}' not found`);
  }

  const roleId = roleResult.rows[0].id;

  const query = `
    UPDATE users 
    SET role_id = $1, updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING id, phone_number, kyc_level, role_id, two_factor_secret, backup_codes, is_active, deactivated_at, created_at, updated_at
  `;

  const result = await pool.query(query, [roleId, userId]);

  if (result.rows.length === 0) {
    throw new Error("User not found");
  }

  const row = result.rows[0];
  const user = {
    ...row,
    phone_number: decrypt(row.phone_number) as string,
    two_factor_secret: decrypt(row.two_factor_secret),
    role_name: roleName
  };

  return user;
}

export interface UpdateUserByIdInput {
  email?: string;
  phone_number?: string;
  display_name?: string | null;
  mcc?: string | null;
  first_name?: string;
  last_name?: string;
  address?: string;
  date_of_birth?: string;
  id_number?: string;
  kyc_level?: string;
  status?: string;
}

export const ALLOWED_USER_UPDATE_FIELDS: (keyof UpdateUserByIdInput)[] = [
  "email",
  "phone_number",
  "display_name",
  "mcc",
  "first_name",
  "last_name",
  "address",
  "date_of_birth",
  "id_number",
  "kyc_level",
  "status",
];

/**
 * Update user by id
 */
export async function updateUserById(
  userId: string,
  userUpdate: Partial<UpdateUserByIdInput>,
): Promise<User> {
  const allowedKeys = ALLOWED_USER_UPDATE_FIELDS as const;
  const keys = Object.keys(userUpdate).filter((k) =>
    allowedKeys.includes(k as any),
  ) as (keyof UpdateUserByIdInput)[];

  if (keys.length === 0) {
    throw new Error("No valid fields to update");
  }

  const setClauses: string[] = [];
  const values: any[] = [];
  let idx = 1;

  for (const k of keys) {
    let value = userUpdate[k];

    if (k === "mcc") {
      if (value !== undefined && value !== null) {
        if (typeof value !== "string" || !isValidMerchantMCC(value)) {
          throw new Error(`Invalid Merchant MCC code '${value}'.`);
        }
        value = value.trim();
      }
    }

    if (k === "phone_number") {
      if (value !== undefined && value !== null) {
        value = encrypt(String(value), true);
      }
    }

    if (k === "email") {
      if (value !== undefined && value !== null) {
        value = encrypt(String(value));
      }
    }

    if (k === "first_name" || k === "last_name" || k === "address" || k === "date_of_birth" || k === "id_number") {
      if (value !== undefined && value !== null) {
        value = encrypt(String(value));
      }
    }

    setClauses.push(`${k} = ($${idx})`);
    values.push(value);
    idx++;
  }

  const query = `UPDATE users
                SET ${setClauses.join(", ")}, updated_at = CURRENT_TIMESTAMP
                WHERE id = ($${idx})
                RETURNING *`;

  try {
    const result = await pool.query(query, [...values, userId]);

    if (!result.rowCount) {
      throw new Error(`User '${userId}' not found`);
    }

    const row = result.rows[0];
    return {
      ...row,
      phone_number: decrypt(row.phone_number) as string,
      two_factor_secret: decrypt(row.two_factor_secret),
      display_name: row.display_name ?? null,
      mcc: row.mcc ?? null,
      email: decrypt(row.email),
    };
  } catch (err) {
    logger.error({ err, userId }, "updateUser error");
    throw err;
  }
}

/**
 * Deactivate user account
 * @param userId
 * @returns void
 */
export async function deactivateUserAccount(userId: string, dbPool?: Pool) {
  let client: PoolClient | undefined;

  try {
    client = await (dbPool ?? pool).connect();

    await client.query("BEGIN");

    // 1. Confirm user exists
    const user = await getUserById(userId);
    if (!user) {
      throw new Error(`User '${userId}' not found`);
    }

    // 2. Scrub PII while preserving foreign keys
    // The `is_active` and `deactivated_at` columns are declared in the
    // users table schema (see migrations) and mirrored on the `User` type.
    await client.query(
      `UPDATE users
       SET 
         first_name = $1,
         last_name = $2,
         address = NULL,
         date_of_birth = NULL,
         two_factor_secret = NULL,
         backup_codes = NULL,
         is_active = false,
         deactivated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      ["Deactivated", "User", userId],
    );

    await client.query("COMMIT");
  } catch (err) {
    if (client) {
      await client.query("ROLLBACK");
    }
    logger.error({ err, userId }, "deactivateUserAccount error");
    throw err;
  } finally {
    if (client) client.release();
  }
}

/**
 * Authenticate user (simplified for demo)
 * In a real app, you would verify phone number via OTP, password, etc.
 */
export async function authenticateUser(
  phoneNumber: string,
): Promise<User | null> {
  const user = await getUserByPhoneNumber(phoneNumber);

  if (!user) {
    // Auto-create user for demo (in production, require proper registration)
    try {
      return await createUser({ phone_number: phoneNumber });
    } catch (error) {
      logger.error({ err: error }, "Failed to create user");
      return null;
    }
  }

  return user;
}

/**
 * Get all users with their roles (admin function)
 */
export async function getAllUsers(): Promise<User[]> {
  const query = `
    SELECT 
      u.id,
      u.phone_number,
      u.kyc_level,
      u.role_id,
      u.two_factor_secret,
      u.two_factor_enabled,
      u.two_factor_verified,
      u.backup_codes,
      u.created_at,
      u.updated_at,
      r.name as role_name
    FROM users u
    LEFT JOIN roles r ON u.role_id = r.id
    ORDER BY u.created_at DESC
  `;

  const result = await pool.query(query);
  return result.rows.map((row) => ({
    ...row,
    phone_number: decrypt(row.phone_number) as string,
    two_factor_secret: decrypt(row.two_factor_secret),
  }));
}

/**
 * Get user permissions
 */
export async function getUserPermissions(userId: string): Promise<string[]> {
  const query = `
    SELECT p.name as permission_name
    FROM permissions p
    JOIN role_permissions rp ON p.id = rp.permission_id
    JOIN users u ON u.role_id = rp.role_id
    WHERE u.id = $1
  `;

  const result = await pool.query(query, [userId]);
  return result.rows.map((row) => row.permission_name);
}

export async function invalidateUserOnPasswordChange(userId: string): Promise<void> {
  const userModel = new UserModel();
  
  // 1. Increment DB token version (persisted invalidation)
  try {
    await userModel.incrementTokenVersion(userId);
  } catch (error: any) {
    // Graceful fallback: Ignore missing column error if the DB migration hasn't run yet
    if (error.code !== '42703') throw error; 
  }

  // 2. Revoke all refresh token families
  try {
    await pool.query(`UPDATE refresh_token_families SET is_revoked = true WHERE user_id = $1`, [userId]);
  } catch (error) {
    logger.error({ err: error, userId }, "Failed to revoke refresh tokens");
  }

  // 3. Flush Redis express-sessions and flag active stateless JWTs
  await flushUserSessions(userId);
}

/**
 * Revokes active sessions for a user after a non-active status change
 * (freeze/suspend/deactivate) so open WebSockets and GraphQL subscriptions are
 * terminated immediately (issue #814). `flushUserSessions` also publishes the
 * cross-instance `ws.auth.revoked` event.
 */
export async function revokeUserSessionsOnStatusChange(
  userId: string,
  status: string,
): Promise<void> {
  if (status === "active") return;
  await flushUserSessions(userId);
}
