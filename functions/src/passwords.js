"use strict";

const {
  createHash,
  randomBytes,
  scrypt: scryptCallback,
  timingSafeEqual
} = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(scryptCallback);
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const KEY_LENGTH = 64;
const LEGACY_PASSWORD_SALT = "kktr_salt_2024"; // Migration-only compatibility; never use for new passwords.
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])$/;
const PASSWORD_MIN_LENGTH = 12;

function normalizeUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidUsername(value) {
  const username = normalizeUsername(value);
  return username.length >= 3 && username.length <= 64 && USERNAME_PATTERN.test(username);
}

function validatePassword(value) {
  return typeof value === "string" &&
    value.length >= PASSWORD_MIN_LENGTH &&
    value.length <= 256 &&
    value.trim().length > 0;
}

async function createPasswordCredential(password) {
  if (typeof password !== "string" || password.length < 1 || password.length > 256) {
    throw new TypeError("Password must be a non-empty string of at most 256 characters.");
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return {
    algorithm: "scrypt",
    version: 1,
    salt: salt.toString("base64"),
    hash: Buffer.from(derived).toString("base64"),
    params: {
      N: SCRYPT_OPTIONS.N,
      r: SCRYPT_OPTIONS.r,
      p: SCRYPT_OPTIONS.p,
      keyLength: KEY_LENGTH
    },
    updatedAt: new Date().toISOString()
  };
}

async function verifyPasswordCredential(password, credential) {
  if (!credential || credential.algorithm !== "scrypt" ||
      typeof credential.salt !== "string" || typeof credential.hash !== "string") {
    return false;
  }
  try {
    const params = credential.params || {};
    const N = Number(params.N);
    const r = Number(params.r);
    const p = Number(params.p);
    const keyLength = Number(params.keyLength);
    if (!Number.isSafeInteger(N) || N < 16384 || N > 131072 ||
        !Number.isSafeInteger(r) || r < 1 || r > 16 ||
        !Number.isSafeInteger(p) || p < 1 || p > 4 ||
        keyLength !== KEY_LENGTH) return false;
    const salt = Buffer.from(credential.salt, "base64");
    const expected = Buffer.from(credential.hash, "base64");
    if (salt.length < 16 || salt.length > 64 || expected.length !== KEY_LENGTH) return false;
    const derived = Buffer.from(await scrypt(password, salt, keyLength, {
      N, r, p, maxmem: 128 * 1024 * 1024
    }));
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function verifyLegacyPassword(password, legacyHash) {
  if (typeof password !== "string" || typeof legacyHash !== "string" ||
      !/^[a-f0-9]{64}$/i.test(legacyHash)) return false;
  const computed = createHash("sha256")
    .update(password + LEGACY_PASSWORD_SALT, "utf8")
    .digest();
  const expected = Buffer.from(legacyHash, "hex");
  return expected.length === computed.length && timingSafeEqual(computed, expected);
}

function sanitizeProfile(profile, username) {
  const safe = { ...(profile || {}) };
  delete safe.pwdHash;
  delete safe.pendingPasswordReset;
  delete safe.passwordHash;
  safe.id = username;
  safe.username = username;
  return safe;
}

module.exports = {
  LEGACY_PASSWORD_SALT,
  PASSWORD_MIN_LENGTH,
  SCRYPT_OPTIONS,
  createPasswordCredential,
  isValidUsername,
  normalizeUsername,
  sanitizeProfile,
  validatePassword,
  verifyLegacyPassword,
  verifyPasswordCredential
};
