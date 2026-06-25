import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifyRegistrationResponseOpts,
  type VerifyAuthenticationResponseOpts,
} from "@simplewebauthn/server";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/types";
import { pool } from "../config/database";
import { redisClient } from "../config/redis";

export const CHALLENGE_TTL_SECONDS = 300; // 5 minutes

export function getRpConfig(): { rpName: string; rpID: string; origin: string } {
  return {
    rpName: process.env.WEBAUTHN_RP_NAME ?? "ProxyPay",
    rpID: process.env.WEBAUTHN_RP_ID ?? "localhost",
    origin: process.env.WEBAUTHN_ORIGIN ?? "http://localhost:3000",
  };
}

// ── Passkey DB helpers ────────────────────────────────────────────────────────

interface PasskeyRow {
  credential_id: string;
  public_key: string;
  counter: string;
  device_type: string;
  backed_up: boolean;
  transports: string[] | null;
}

async function getCredentialsForUser(userId: string): Promise<PasskeyRow[]> {
  const { rows } = await pool.query<PasskeyRow>(
    `SELECT credential_id, public_key, counter, device_type, backed_up, transports
     FROM passkey_credentials WHERE user_id = $1`,
    [userId],
  );
  return rows;
}

async function saveCredential(
  userId: string,
  credentialId: string,
  publicKey: string,
  counter: number,
  deviceType: string,
  backedUp: boolean,
  transports: string[],
): Promise<void> {
  await pool.query(
    `INSERT INTO passkey_credentials
       (user_id, credential_id, public_key, counter, device_type, backed_up, transports)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, credentialId, publicKey, counter, deviceType, backedUp, transports],
  );
}

async function updateCredentialCounter(
  credentialId: string,
  counter: number,
): Promise<void> {
  await pool.query(
    `UPDATE passkey_credentials SET counter = $1, last_used_at = NOW() WHERE credential_id = $2`,
    [counter, credentialId],
  );
}

async function getCredentialById(credentialId: string): Promise<PasskeyRow & { user_id: string } | null> {
  const { rows } = await pool.query<PasskeyRow & { user_id: string }>(
    `SELECT user_id, credential_id, public_key, counter, device_type, backed_up, transports
     FROM passkey_credentials WHERE credential_id = $1`,
    [credentialId],
  );
  return rows[0] ?? null;
}

// ── Challenge store (Redis) ───────────────────────────────────────────────────

function challengeKey(userId: string, type: "reg" | "auth"): string {
  return `webauthn:challenge:${type}:${userId}`;
}

async function storeChallenge(userId: string, type: "reg" | "auth", challenge: string): Promise<void> {
  await redisClient.set(challengeKey(userId, type), challenge, { EX: CHALLENGE_TTL_SECONDS });
}

async function consumeChallenge(userId: string, type: "reg" | "auth"): Promise<string | null> {
  const key = challengeKey(userId, type);
  const challenge = await redisClient.get(key);
  if (challenge) await redisClient.del(key);
  return challenge;
}

// ── Registration ─────────────────────────────────────────────────────────────

export async function generateRegistrationOptionsForUser(
  userId: string,
  userEmail: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpName, rpID } = getRpConfig();
  const existingCredentials = await getCredentialsForUser(userId);

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: userEmail,
    attestationType: "none",
    excludeCredentials: existingCredentials.map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? []) as AuthenticatorTransport[],
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  await storeChallenge(userId, "reg", options.challenge);
  return options;
}

export async function verifyRegistration(
  userId: string,
  response: RegistrationResponseJSON,
): Promise<{ credentialId: string }> {
  const { rpID, origin } = getRpConfig();
  const expectedChallenge = await consumeChallenge(userId, "reg");
  if (!expectedChallenge) throw new Error("Challenge expired or not found");

  const opts: VerifyRegistrationResponseOpts = {
    response,
    expectedChallenge,
    expectedRPID: rpID,
    expectedOrigin: origin,
    requireUserVerification: false,
  };

  const { verified, registrationInfo } = await verifyRegistrationResponse(opts);
  if (!verified || !registrationInfo) throw new Error("Registration verification failed");

  const { credential, credentialDeviceType, credentialBackedUp } = registrationInfo;

  await saveCredential(
    userId,
    credential.id,
    Buffer.from(credential.publicKey).toString("base64url"),
    credential.counter,
    credentialDeviceType,
    credentialBackedUp,
    (credential.transports ?? []) as string[],
  );

  return { credentialId: credential.id };
}

// ── Authentication ────────────────────────────────────────────────────────────

export async function generateAuthenticationOptionsForUser(
  userId: string,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpID } = getRpConfig();
  const credentials = await getCredentialsForUser(userId);

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
    allowCredentials: credentials.map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? []) as AuthenticatorTransport[],
    })),
  });

  await storeChallenge(userId, "auth", options.challenge);
  return options;
}

export async function verifyAuthentication(
  userId: string,
  response: AuthenticationResponseJSON,
): Promise<{ credentialId: string }> {
  const { rpID, origin } = getRpConfig();
  const expectedChallenge = await consumeChallenge(userId, "auth");
  if (!expectedChallenge) throw new Error("Challenge expired or not found");

  const cred = await getCredentialById(response.id);
  if (!cred || cred.user_id !== userId) throw new Error("Credential not found");

  const opts: VerifyAuthenticationResponseOpts = {
    response,
    expectedChallenge,
    expectedRPID: rpID,
    expectedOrigin: origin,
    requireUserVerification: false,
    credential: {
      id: cred.credential_id,
      publicKey: Buffer.from(cred.public_key, "base64url"),
      counter: Number(cred.counter),
      transports: (cred.transports ?? []) as AuthenticatorTransport[],
    },
  };

  const { verified, authenticationInfo } = await verifyAuthenticationResponse(opts);
  if (!verified) throw new Error("Authentication verification failed");

  await updateCredentialCounter(cred.credential_id, authenticationInfo.newCounter);
  return { credentialId: cred.credential_id };
}
