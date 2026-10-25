"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  LEGACY_PASSWORD_SALT,
  PASSWORD_MIN_LENGTH,
  createPasswordCredential,
  isValidUsername,
  normalizeUsername,
  sanitizeProfile,
  validatePassword,
  verifyLegacyPassword,
  verifyPasswordCredential
} = require("../src/passwords");

test("username normalization is deterministic and rejects unsafe IDs", () => {
  assert.equal(normalizeUsername("  Abraham.Sackey  "), "abraham.sackey");
  assert.equal(isValidUsername("abraham.sackey"), true);
  assert.equal(isValidUsername(" abraham.sackey "), true);
  assert.equal(isValidUsername("a/b"), false);
  assert.equal(isValidUsername("ab"), false);
  assert.equal(isValidUsername("Upper Case"), false);
  assert.equal(isValidUsername("x".repeat(65)), false);
});

test("new passwords require a strong minimum and a bounded maximum", () => {
  assert.equal(PASSWORD_MIN_LENGTH, 12);
  assert.equal(validatePassword("Short8!"), false);
  assert.equal(validatePassword("Correct-Horse-Battery-9"), true);
  assert.equal(validatePassword("x".repeat(257)), false);
  assert.equal(validatePassword("            "), false);
});

test("scrypt credential verifies correct password and rejects wrong password", async () => {
  const credential = await createPasswordCredential("Correct-Horse-Battery-9");
  assert.equal(credential.algorithm, "scrypt");
  assert.equal(credential.salt.length > 0, true);
  assert.equal(await verifyPasswordCredential("Correct-Horse-Battery-9", credential), true);
  assert.equal(await verifyPasswordCredential("incorrect-password", credential), false);
  assert.equal(await verifyPasswordCredential("Correct-Horse-Battery-9", null), false);
});

test("legacy fixed-salt hash is accepted only for migration verification", () => {
  const password = "LegacyPassword123";
  const hash = createHash("sha256").update(password + LEGACY_PASSWORD_SALT).digest("hex");
  assert.equal(verifyLegacyPassword(password, hash), true);
  assert.equal(verifyLegacyPassword("wrong-password", hash), false);
  assert.equal(verifyLegacyPassword(password, "not-a-hash"), false);
});

test("sanitized profile never returns legacy hashes or pending reset plaintext", () => {
  const result = sanitizeProfile({
    username: "someone",
    role: "dept",
    pwdHash: "legacy-hash",
    pendingPasswordReset: "plain-reset-password",
    displayPreference: "compact"
  }, "someone");
  assert.equal(result.id, "someone");
  assert.equal(result.username, "someone");
  assert.equal(result.role, "dept");
  assert.equal(result.displayPreference, "compact");
  assert.equal("pwdHash" in result, false);
  assert.equal("pendingPasswordReset" in result, false);
});
