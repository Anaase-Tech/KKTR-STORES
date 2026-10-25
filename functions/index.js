"use strict";

const { createHash } = require("node:crypto");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, Timestamp, getFirestore } = require("firebase-admin/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/logger");
const {
  createPasswordCredential,
  isValidUsername,
  normalizeUsername,
  sanitizeProfile,
  validatePassword,
  verifyLegacyPassword,
  verifyPasswordCredential
} = require("./src/passwords");
const { normalizeWorkerName, validateWorkerInput } = require("./src/workers");

if (getApps().length === 0) initializeApp();

const db = getFirestore();
const auth = getAuth();
const DEPARTMENTS = new Set([
  "Log Yard", "Sawmill", "Saw Shop", "Workshop", "Charcoal",
  "Kindry", "Chainsaw", "Security", "Administration", "HR"
]);
const ROLES = new Set(["admin", "coo", "store_manager", "hr", "dept"]);
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_RECORD_TTL_MS = 48 * 60 * 60 * 1000;

setGlobalOptions({ region: "us-central1", maxInstances: 10 });

function fail(code, message) {
  throw new HttpsError(code, message);
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function requestIp(request) {
  const raw = request && request.rawRequest && request.rawRequest.ip;
  return typeof raw === "string" && raw ? raw : "unknown";
}

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

async function consumeRateLimit(namespace, key, maxAttempts, windowMs = RATE_WINDOW_MS) {
  const id = digest(namespace + "|" + key);
  const ref = db.collection("_securityRateLimits").doc(id);
  const now = Date.now();
  let allowed = true;

  await db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    const data = snap.exists ? snap.data() : null;
    const started = Number(data && data.windowStartedAt);
    const count = Number(data && data.count) || 0;
    if (!data || !Number.isFinite(started) || now - started >= windowMs || now < started) {
      transaction.set(ref, {
        namespace,
        windowStartedAt: now,
        count: 1,
        expiresAt: Timestamp.fromMillis(now + RATE_RECORD_TTL_MS)
      });
      return;
    }
    if (count >= maxAttempts) {
      allowed = false;
      return;
    }
    transaction.update(ref, {
      count: count + 1,
      expiresAt: Timestamp.fromMillis(now + RATE_RECORD_TTL_MS)
    });
  });

  return allowed;
}

async function assertRateLimit(namespace, key, maxAttempts, windowMs) {
  const allowed = await consumeRateLimit(namespace, key, maxAttempts, windowMs);
  if (!allowed) fail("resource-exhausted", "Too many attempts. Please try again later.");
}

async function getCallerProfile(request) {
  if (!request.auth || !request.auth.uid) fail("unauthenticated", "Sign in is required.");
  const uid = request.auth.uid;
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) fail("permission-denied", "The account profile is not active.");
  const profile = snap.data();
  if (profile.disabled === true) fail("permission-denied", "This account has been disabled.");
  const storedVersion = Number(profile.sessionVersion ?? 0);
  const tokenVersion = Number(request.auth.token && request.auth.token.sessionVersion ?? 0);
  if (!Number.isSafeInteger(storedVersion) || storedVersion < 0 ||
      !Number.isSafeInteger(tokenVersion) || tokenVersion !== storedVersion) {
    fail("unauthenticated", "This session has expired. Sign in again.");
  }
  return { uid, profile };
}

async function assertAdministrator(request) {
  const caller = await getCallerProfile(request);
  if (caller.profile.role !== "admin" || caller.profile.approved !== true) {
    fail("permission-denied", "Only an approved system administrator can perform this action.");
  }
  return caller;
}

async function ensureAuthUser(uid, displayName) {
  try {
    const existing = await auth.getUser(uid);
    if (existing.disabled) fail("permission-denied", "This account is disabled.");
    return existing;
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    if (error && error.code !== "auth/user-not-found") throw error;
  }
  try {
    return await auth.createUser({ uid, displayName: cleanText(displayName, 100) || uid });
  } catch (error) {
    if (error && error.code === "auth/uid-already-exists") {
      const existing = await auth.getUser(uid);
      if (existing.disabled) fail("permission-denied", "This account is disabled.");
      return existing;
    }
    logger.error("Could not provision Firebase Auth identity", { uid, code: error && error.code });
    fail("internal", "The account identity could not be initialized. Contact the system administrator.");
  }
}

async function verifyAnyCredential(uid, profile, password) {
  const credentialRef = db.collection("userCredentials").doc(uid);
  const credentialSnap = await credentialRef.get();
  if (credentialSnap.exists) {
    return {
      matches: await verifyPasswordCredential(password, credentialSnap.data()),
      legacy: false,
      credentialRef
    };
  }

  const legacyHash = profile && profile.pwdHash;
  if (verifyLegacyPassword(password, legacyHash)) {
    return { matches: true, legacy: true, credentialRef };
  }
  return { matches: false, legacy: false, credentialRef };
}

async function migrateLegacyCredential(uid, profile, credentialRef, password) {
  const credential = await createPasswordCredential(password);
  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async transaction => {
    const [credentialSnap, userSnap] = await Promise.all([
      transaction.get(credentialRef),
      transaction.get(userRef)
    ]);
    if (!userSnap.exists) fail("unauthenticated", "Invalid username or password.");
    if (!credentialSnap.exists) transaction.create(credentialRef, {
      ...credential,
      createdAt: FieldValue.serverTimestamp(),
      migration: "legacy-sha256-to-scrypt-v1"
    });
    transaction.update(userRef, {
      pwdHash: FieldValue.delete(),
      pendingPasswordReset: FieldValue.delete(),
      credentialMigratedAt: FieldValue.serverTimestamp()
    });
  });
}


function directoryProfile(profile, username) {
  return {
    id: username,
    username,
    name: cleanText(profile && profile.name, 100) || username,
    dept: cleanText(profile && profile.dept, 100),
    role: ROLES.has(profile && profile.role) ? profile.role : "dept",
    approved: profile && profile.approved === true,
    disabled: profile && profile.disabled === true,
    createdAt: profile && profile.createdAt ? profile.createdAt : null,
    approvedAt: profile && profile.approvedAt ? profile.approvedAt : null,
    roleChangedAt: profile && profile.roleChangedAt ? profile.roleChangedAt : null
  };
}

async function syncAccountDirectory(username, profile) {
  await db.collection("accountDirectory").doc(username).set({
    ...directoryProfile(profile, username),
    directoryUpdatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

async function refreshAccountDirectory() {
  const snapshot = await db.collection("users").get();
  // Keep each batch below Firestore's 500-write limit.
  for (let offset = 0; offset < snapshot.docs.length; offset += 400) {
    const batch = db.batch();
    const chunk = snapshot.docs.slice(offset, offset + 400);
    for (const account of chunk) {
      batch.set(db.collection("accountDirectory").doc(account.id), {
        ...directoryProfile(account.data(), account.id),
        directoryUpdatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    if (chunk.length) await batch.commit();
  }
  return snapshot.docs.map(d => directoryProfile(d.data(), d.id));
}

exports.addWorker = onCall({ maxInstances: 5 }, async request => {
  const actor = await getCallerProfile(request);
  if (actor.profile.role !== "hr" || actor.profile.approved !== true) {
    fail("permission-denied", "Only an approved HR user can add workers.");
  }

  const validated = validateWorkerInput(request.data || {});
  if (!validated.ok) fail("invalid-argument", validated.reason);
  const worker = validated.worker;
  const workerRef = db.collection("workers").doc();
  const nameKeyRef = db.collection("workerNameKeys").doc(digest(worker.nameKey));
  const existingWorkers = db.collection("workers");
  await db.runTransaction(async transaction => {
    const nameKeySnap = await transaction.get(nameKeyRef);
    if (nameKeySnap.exists) fail("already-exists", "A worker with this normalized name already exists.");
    const workerSnapshot = await transaction.get(existingWorkers);
    const duplicate = workerSnapshot.docs.some(item =>
      normalizeWorkerName(item.data().name) === worker.nameKey
    );
    if (duplicate) fail("already-exists", "A worker with this normalized name already exists.");
    transaction.create(workerRef, {
      ...worker,
      addedBy: cleanText(actor.profile.name, 100) || actor.uid,
      addedByUid: actor.uid,
      createdAt: FieldValue.serverTimestamp()
    });
    transaction.create(nameKeyRef, {
      workerId: workerRef.id,
      nameKey: worker.nameKey,
      createdAt: FieldValue.serverTimestamp()
    });
  });

  return { ok: true, workerId: workerRef.id, worker };
});

exports.deleteWorker = onCall({ maxInstances: 5 }, async request => {
  const actor = await getCallerProfile(request);
  if (actor.profile.role !== "hr" || actor.profile.approved !== true) {
    fail("permission-denied", "Only an approved HR user can remove workers.");
  }
  const workerId = cleanText(request.data && request.data.workerId, 150);
  if (!workerId || workerId.includes("/")) fail("invalid-argument", "A valid worker ID is required.");

  const workerRef = db.collection("workers").doc(workerId);
  await db.runTransaction(async transaction => {
    const workerSnap = await transaction.get(workerRef);
    if (!workerSnap.exists) fail("not-found", "Worker was not found.");
    const worker = workerSnap.data();
    const key = normalizeWorkerName(worker.name);
    const nameKeyRef = db.collection("workerNameKeys").doc(digest(key));
    const keySnap = await transaction.get(nameKeyRef);
    if (keySnap.exists && keySnap.data().workerId === workerId) {
      transaction.delete(nameKeyRef);
    }
    transaction.delete(workerRef);
  });

  return { ok: true, workerId };
});

exports.listAccounts = onCall({ maxInstances: 5 }, async request => {
  await assertAdministrator(request);
  const accounts = await refreshAccountDirectory();
  return { accounts };
});

exports.authenticateUser = onCall({ maxInstances: 10 }, async request => {
  const username = normalizeUsername(request.data && request.data.username);
  const password = request.data && request.data.password;
  const ip = requestIp(request);
  await assertRateLimit("login", digest(ip + "|" + username), 10, RATE_WINDOW_MS);

  if (!isValidUsername(username) || typeof password !== "string" ||
      password.length < 1 || password.length > 256) {
    fail("unauthenticated", "Invalid username or password.");
  }

  const userRef = db.collection("users").doc(username);
  const userSnap = await userRef.get();
  if (!userSnap.exists) fail("unauthenticated", "Invalid username or password.");
  const profile = userSnap.data();

  if (profile.disabled === true) fail("permission-denied", "This account has been disabled.");
  if (profile.role !== "admin" && profile.approved !== true) {
    fail("permission-denied", "This account is awaiting administrator approval.");
  }
  if (!ROLES.has(profile.role)) fail("permission-denied", "This account has an invalid role assignment.");

  const verification = await verifyAnyCredential(username, profile, password);
  if (!verification.matches) {
    fail("unauthenticated", "Invalid username or password.");
  }

  if (verification.legacy) {
    await migrateLegacyCredential(username, profile, verification.credentialRef, password);
  } else if (profile.pwdHash || profile.pendingPasswordReset) {
    await userRef.update({
      pwdHash: FieldValue.delete(),
      pendingPasswordReset: FieldValue.delete(),
      credentialMigratedAt: FieldValue.serverTimestamp()
    });
  }

  // Seed a server-side session version for existing legacy profiles before issuing
  // any signed-in token; this lets rules revoke older tokens after role/password changes.
  const refreshedProfile = (await userRef.get()).data();
  const sessionVersion = Number.isSafeInteger(refreshedProfile.sessionVersion) &&
    refreshedProfile.sessionVersion >= 0 ? refreshedProfile.sessionVersion : 0;
  if (refreshedProfile.sessionVersion !== sessionVersion) {
    await userRef.update({ sessionVersion });
  }
  const authenticatedProfile = { ...refreshedProfile, sessionVersion };
  await ensureAuthUser(username, authenticatedProfile.name || username);
  await syncAccountDirectory(username, authenticatedProfile);
  const token = await auth.createCustomToken(username, {
    role: authenticatedProfile.role,
    dept: cleanText(authenticatedProfile.dept, 100),
    sessionVersion
  });
  return {
    token,
    profile: sanitizeProfile(authenticatedProfile, username)
  };
});

exports.registerDepartmentHead = onCall({ maxInstances: 5 }, async request => {
  const data = request.data || {};
  const username = normalizeUsername(data.username);
  const name = cleanText(data.name, 100);
  const dept = cleanText(data.dept, 100);
  const password = data.password;
  const ip = requestIp(request);
  await assertRateLimit("register", digest(ip), 5, 60 * 60 * 1000);

  if (!isValidUsername(username)) fail("invalid-argument", "Username must be 3–64 characters using lowercase letters, numbers, dots, underscores, or hyphens.");
  if (name.length < 2) fail("invalid-argument", "Enter the full name.");
  if (!DEPARTMENTS.has(dept) || dept === "Administration" || dept === "HR") {
    fail("invalid-argument", "Select a department that may register a Department Head.");
  }
  if (!validatePassword(password)) fail("invalid-argument", "Password must contain at least 12 characters.");

  const userRef = db.collection("users").doc(username);
  const credentialRef = db.collection("userCredentials").doc(username);
  const credential = await createPasswordCredential(password);
  let created = false;

  await db.runTransaction(async transaction => {
    const [userSnap, credentialSnap] = await Promise.all([
      transaction.get(userRef),
      transaction.get(credentialRef)
    ]);
    if (userSnap.exists || credentialSnap.exists) fail("already-exists", "That username is already registered.");
    transaction.create(userRef, {
      id: username,
      username,
      name,
      dept,
      role: "dept",
      approved: false,
      sessionVersion: 0,
      createdAt: FieldValue.serverTimestamp()
    });
    transaction.create(credentialRef, {
      ...credential,
      createdAt: FieldValue.serverTimestamp(),
      migration: "native-scrypt-v1"
    });
    created = true;
  });

  if (created) {
    await ensureAuthUser(username, name);
    await syncAccountDirectory(username, {
      id: username, username, name, dept, role: "dept", approved: false
    });
  }
  return { ok: true, username, status: "pending-approval" };
});

exports.requestPasswordReset = onCall({ maxInstances: 5 }, async request => {
  const username = normalizeUsername(request.data && request.data.username);
  const ip = requestIp(request);
  await assertRateLimit("password-reset", digest(ip + "|" + username), 5, 60 * 60 * 1000);

  if (isValidUsername(username)) {
    const userSnap = await db.collection("users").doc(username).get();
    if (userSnap.exists && userSnap.data().disabled !== true) {
      const profile = userSnap.data();
      await db.collection("passwordResets").add({
        userId: username,
        username,
        name: cleanText(profile.name, 100),
        dept: cleanText(profile.dept, 100),
        status: "pending",
        requestedAt: FieldValue.serverTimestamp(),
        source: "self-service"
      });
    }
  }

  // Do not reveal whether a given username exists.
  return { ok: true };
});

exports.approveDepartmentHead = onCall({ maxInstances: 5 }, async request => {
  const { uid: actorUid } = await assertAdministrator(request);
  const targetId = normalizeUsername(request.data && request.data.username);
  if (!isValidUsername(targetId)) fail("invalid-argument", "A valid username is required.");
  const targetRef = db.collection("users").doc(targetId);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists || targetSnap.data().role !== "dept") {
    fail("not-found", "Department Head account was not found.");
  }
  await targetRef.update({
    approved: true,
    approvedBy: actorUid,
    approvedAt: FieldValue.serverTimestamp()
  });
  await syncAccountDirectory(targetId, (await targetRef.get()).data());
  return { ok: true, username: targetId, approved: true };
});

exports.setAccountRole = onCall({ maxInstances: 5 }, async request => {
  const { uid: actorUid } = await assertAdministrator(request);
  const targetId = normalizeUsername(request.data && request.data.username);
  const nextRole = request.data && request.data.role;
  if (!isValidUsername(targetId) || !ROLES.has(nextRole)) {
    fail("invalid-argument", "A valid username and role are required.");
  }

  const targetRef = db.collection("users").doc(targetId);
  await db.runTransaction(async transaction => {
    const targetSnap = await transaction.get(targetRef);
    if (!targetSnap.exists) fail("not-found", "Account was not found.");
    const target = targetSnap.data();
    if (target.role === "admin" && nextRole !== "admin") {
      const admins = await transaction.get(
        db.collection("users").where("role", "==", "admin").where("approved", "==", true)
      );
      if (admins.size <= 1) fail("failed-precondition", "The final approved administrator cannot be demoted.");
    }
    transaction.update(targetRef, {
      role: nextRole,
      roleChangedBy: actorUid,
      roleChangedAt: FieldValue.serverTimestamp(),
      sessionVersion: (Number(target.sessionVersion) || 0) + 1
    });
  });
  await syncAccountDirectory(targetId, (await targetRef.get()).data());

  return { ok: true, username: targetId, role: nextRole };
});

exports.resetUserPassword = onCall({ maxInstances: 5 }, async request => {
  const { uid: actorUid } = await assertAdministrator(request);
  const targetId = normalizeUsername(request.data && request.data.username);
  const newPassword = request.data && request.data.newPassword;
  if (!isValidUsername(targetId)) fail("invalid-argument", "A valid username is required.");
  if (!validatePassword(newPassword)) fail("invalid-argument", "New password must contain at least 12 characters.");

  const userRef = db.collection("users").doc(targetId);
  const userSnap = await userRef.get();
  if (!userSnap.exists) fail("not-found", "Account was not found.");
  if (userSnap.data().disabled === true) fail("failed-precondition", "The account is disabled.");

  const credential = await createPasswordCredential(newPassword);
  const credentialRef = db.collection("userCredentials").doc(targetId);
  await credentialRef.set({
    ...credential,
    createdAt: FieldValue.serverTimestamp(),
    changedBy: actorUid,
    migration: "native-scrypt-v1"
  });
  await userRef.update({
    pwdHash: FieldValue.delete(),
    pendingPasswordReset: FieldValue.delete(),
    passwordResetBy: actorUid,
    passwordResetAt: FieldValue.serverTimestamp(),
    sessionVersion: (Number(userSnap.data().sessionVersion) || 0) + 1
  });
  await syncAccountDirectory(targetId, (await userRef.get()).data());

  const pending = await db.collection("passwordResets")
    .where("userId", "==", targetId).where("status", "==", "pending").limit(100).get();
  if (!pending.empty) {
    const batch = db.batch();
    pending.docs.forEach(docSnap => batch.update(docSnap.ref, {
      status: "completed",
      completedBy: actorUid,
      completedAt: FieldValue.serverTimestamp()
    }));
    await batch.commit();
  }

  try {
    await auth.revokeRefreshTokens(targetId);
  } catch (error) {
    if (!error || error.code !== "auth/user-not-found") {
      logger.warn("Could not revoke tokens after password reset", { targetId, code: error && error.code });
    }
  }
  return { ok: true, username: targetId };
});

exports.changeOwnPassword = onCall({ maxInstances: 5 }, async request => {
  const { uid, profile } = await getCallerProfile(request);
  const oldPassword = request.data && request.data.oldPassword;
  const newPassword = request.data && request.data.newPassword;
  if (typeof oldPassword !== "string" || oldPassword.length < 1 || oldPassword.length > 256) {
    fail("invalid-argument", "Enter your current password.");
  }
  if (!validatePassword(newPassword)) fail("invalid-argument", "New password must contain at least 12 characters.");

  const verification = await verifyAnyCredential(uid, profile, oldPassword);
  if (!verification.matches) fail("unauthenticated", "Current password is incorrect.");

  const credential = await createPasswordCredential(newPassword);
  await db.collection("userCredentials").doc(uid).set({
    ...credential,
    createdAt: FieldValue.serverTimestamp(),
    changedBy: uid,
    migration: "native-scrypt-v1"
  });
  await db.collection("users").doc(uid).update({
    pwdHash: FieldValue.delete(),
    pendingPasswordReset: FieldValue.delete(),
    passwordChangedAt: FieldValue.serverTimestamp(),
    sessionVersion: (Number(profile.sessionVersion) || 0) + 1
  });
  const token = await auth.createCustomToken(uid, {
    role: profile.role,
    dept: cleanText(profile.dept, 100),
    sessionVersion: (Number(profile.sessionVersion) || 0) + 1
  });
  return { ok: true, token };
});

exports.deleteAccount = onCall({ maxInstances: 3 }, async request => {
  const { uid: actorUid } = await assertAdministrator(request);
  const targetId = normalizeUsername(request.data && request.data.username);
  if (!isValidUsername(targetId)) fail("invalid-argument", "A valid username is required.");
  if (targetId === actorUid) fail("failed-precondition", "You cannot delete the account currently in use.");

  const targetRef = db.collection("users").doc(targetId);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) fail("not-found", "Account was not found.");
  if (targetSnap.data().role === "admin") {
    const admins = await db.collection("users").where("role", "==", "admin").where("approved", "==", true).get();
    if (admins.size <= 1) fail("failed-precondition", "The final approved administrator cannot be deleted.");
  }

  try {
    await auth.deleteUser(targetId);
  } catch (error) {
    if (!error || error.code !== "auth/user-not-found") throw error;
  }
  const batch = db.batch();
  batch.delete(targetRef);
  batch.delete(db.collection("accountDirectory").doc(targetId));
  batch.delete(db.collection("userCredentials").doc(targetId));
  const pending = await db.collection("passwordResets").where("userId", "==", targetId).limit(100).get();
  pending.docs.forEach(docSnap => batch.delete(docSnap.ref));
  await batch.commit();
  return { ok: true, username: targetId };
});
