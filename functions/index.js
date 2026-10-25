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
  const tokenVersion = Number((request.auth.token && request.auth.token.sessionVersion) ?? 0);
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


exports.submitReportToCOO = onCall({ maxInstances: 5 }, async request => {
  const { uid, profile } = await getCallerProfile(request);
  const allowedRoles = new Set(["admin", "hr", "store_manager", "coo"]);
  if (!allowedRoles.has(profile.role) || profile.approved !== true) {
    fail("permission-denied", "Only an approved HR, Stores, Admin, or COO account can submit operational reports.");
  }

  const data = request.data || {};
  const type = cleanText(data.type, 30);
  const title = typeof data.title === "string" ? data.title.trim() : "";
  if (!["general", "attendance", "chop", "stores"].includes(type)) {
    fail("invalid-argument", "The report type is not supported.");
  }
  if (!title || title.length > 180) {
    fail("invalid-argument", "A report title of 1–180 characters is required.");
  }

  const periodValue = data.period === undefined || data.period === null
    ? "" : (typeof data.period === "string" ? data.period.trim() : null);
  if (periodValue === null || periodValue.length > 100) {
    fail("invalid-argument", "The report period must be text of at most 100 characters.");
  }
  const deptValue = data.dept === undefined || data.dept === null
    ? "" : (typeof data.dept === "string" ? data.dept.trim() : null);
  if (deptValue === null || deptValue.length > 100) {
    fail("invalid-argument", "The report department must be text of at most 100 characters.");
  }
  const requestedBody = data.body === undefined || data.body === null
    ? "" : (typeof data.body === "string" ? data.body : null);
  if (requestedBody === null || requestedBody.length > 100000) {
    fail("invalid-argument", "The report body must be text no longer than 100,000 characters.");
  }

  let finalPeriod = periodValue;
  let finalDept = deptValue ||
    (profile.role === "hr" ? "HR" : profile.role === "coo" ? "Administration" : "Stores");
  let finalBody = requestedBody;
  let finalSummary = {};
  const now = new Date();
  const dateKey = value => {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    try {
      const date = value && typeof value.toDate === "function"
        ? value.toDate()
        : (value ? new Date(value) : null);
      return date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
    } catch {
      return "";
    }
  };
  const periodMatches = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

  if (type === "attendance") {
    if (profile.role !== "hr" && profile.role !== "coo" && profile.role !== "admin") {
      fail("permission-denied", "Attendance reports may only be filed by HR, Admin, or COO.");
    }
    if (profile.role === "hr" && !periodMatches(finalPeriod)) {
      fail("invalid-argument", "HR attendance reports require a reporting month in YYYY-MM format.");
    }
    const approvedSnapshot = await db.collection("attendanceReports")
      .where("status", "==", "approved").get();
    const reports = approvedSnapshot.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data()
    })).filter(record => {
      if (profile.role === "hr") {
        return record.month === finalPeriod ||
          (typeof record.monthStart === "string" && record.monthStart.startsWith(finalPeriod));
      }
      return true;
    }).sort((a, b) => {
      const aKey = String(a.month || a.monthStart || "");
      const bKey = String(b.month || b.monthStart || "");
      return aKey.localeCompare(bKey) || String(a.dept || "").localeCompare(String(b.dept || ""));
    });
    if (!reports.length) {
      fail("not-found", profile.role === "hr"
        ? "No HR-approved department attendance reports exist for the selected month."
        : "No HR-approved attendance reports are available to file.");
    }
    const departmentLines = [];
    let totalPresent = 0;
    let totalAbsent = 0;
    let totalChopMoney = 0;
    let totalWorkers = 0;
    for (const record of reports) {
      const rows = Array.isArray(record.summary) ? record.summary : [];
      const present = rows.reduce((total, row) => total + (Number(row && row.present) || 0), 0);
      const absent = rows.reduce((total, row) => total + (Number(row && row.absent) || 0), 0);
      const chop = rows.reduce((total, row) => total + (Number(row && row.chopMoney) || 0), 0);
      totalPresent += present;
      totalAbsent += absent;
      totalChopMoney += chop;
      totalWorkers += rows.length;
      departmentLines.push(
        String(record.dept || "Unknown department") + " — " +
        String(record.month || record.monthStart || "Period not recorded") +
        ": " + present + " present, " + absent + " absent, GH₵" + chop + " chop money"
      );
    }
    if (profile.role === "hr") finalDept = "HR";
    if (!finalPeriod || !periodMatches(finalPeriod)) finalPeriod = now.toISOString().slice(0, 10);
    finalBody = [
      "KKTR ATTENDANCE REPORT",
      "Reporting period: " + finalPeriod,
      "",
      ...departmentLines,
      "",
      "TOTALS: " + totalPresent + " present | " + totalAbsent +
        " absent | GH₵" + totalChopMoney + " chop money | " + totalWorkers + " worker-summary rows"
    ].join("\n");
    finalSummary = {
      departments: reports.length,
      totalPresent,
      totalAbsent,
      totalChopMoney,
      workers: totalWorkers
    };
  } else if (type === "chop") {
    if (profile.role !== "hr") {
      fail("permission-denied", "Only HR can file the chop-money report.");
    }
    if (!periodMatches(finalPeriod)) {
      fail("invalid-argument", "Chop-money reports require a reporting month in YYYY-MM format.");
    }
    const chopSnapshot = await db.collection("chopMoney").get();
    const records = chopSnapshot.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data()
    })).filter(record => {
      if (!["approved", "paid"].includes(record.status)) return false;
      const date = dateKey(record.createdAt) || dateKey(record.weekStart);
      return date.startsWith(finalPeriod);
    }).sort((a, b) => String(a.dept || "").localeCompare(String(b.dept || "")) ||
      String(a.weekStart || "").localeCompare(String(b.weekStart || "")));
    if (!records.length) {
      fail("not-found", "No HR-approved chop-money submissions exist for the selected month.");
    }
    let totalAmount = 0;
    let totalDays = 0;
    const lines = ["KKTR APPROVED CHOP-MONEY REPORT", "Reporting period: " + finalPeriod, ""];
    for (const record of records) {
      const amount = Number(record.totalAmount) || 0;
      totalAmount += amount;
      lines.push(String(record.dept || "Unknown department") + " — " +
        String(record.weekStart || "?") + " to " + String(record.weekEnd || "?") +
        " — " + String(record.status) + " — GH₵" + amount);
      for (const worker of (Array.isArray(record.chopList) ? record.chopList : [])) {
        totalDays += Number(worker && worker.days) || 0;
        lines.push("  " + (cleanText(worker && worker.name, 100) || "Unnamed worker") +
          ": " + (Number(worker && worker.days) || 0) + " approved days — GH₵" +
          (Number(worker && worker.amount) || 0));
      }
    }
    lines.push("", "SUBMISSIONS: " + records.length, "APPROVED DAYS: " + totalDays,
      "TOTAL APPROVED CHOP MONEY: GH₵" + totalAmount);
    finalDept = "HR";
    finalBody = lines.join("\n");
    finalSummary = { submissions: records.length, approvedDays: totalDays, totalAmount };
  } else if (type === "stores") {
    if (profile.role !== "admin" && profile.role !== "store_manager") {
      fail("permission-denied", "Only Stores Admin or the Stores Manager can file the Stores report.");
    }
    const range = data.range || {};
    const from = typeof range.from === "string" ? range.from : "";
    const to = typeof range.to === "string" ? range.to : "";
    const validDate = value => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const parsed = new Date(value + "T00:00:00Z");
      return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    };
    if (!validDate(from) || !validDate(to) || from > to) {
      fail("invalid-argument", "Stores reports require a valid start and end date.");
    }
    const [lubricantSnapshot, itemSnapshot, transactionSnapshot, requisitionSnapshot, receiptSnapshot] =
      await Promise.all([
        db.collection("lubricants").get(),
        db.collection("storeItems").get(),
        db.collection("transactions").get(),
        db.collection("requisitions").get(),
        db.collection("receipts").get()
      ]);
    const inRange = record => {
      const key = dateKey(record.date) || dateKey(record.createdAt);
      return Boolean(key && key >= from && key <= to);
    };
    const transactions = transactionSnapshot.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data()
    })).filter(record => inRange(record) && ["lube", "store"].includes(record.type));
    const requisitions = requisitionSnapshot.docs.map(docSnap => docSnap.data()).filter(inRange);
    const receipts = receiptSnapshot.docs.map(docSnap => docSnap.data()).filter(inRange);
    const lubricants = lubricantSnapshot.docs.map(docSnap => docSnap.data());
    const storeItems = itemSnapshot.docs.map(docSnap => docSnap.data());
    const lubeIssued = transactions.filter(record => record.type === "lube" && record.action === "issue");
    const lubeRestocked = transactions.filter(record => record.type === "lube" && record.action === "restock");
    const itemsIssued = transactions.filter(record => record.type === "store" && record.action === "issue");
    const itemsRestocked = transactions.filter(record => record.type === "store" && record.action === "restock");
    const lowLubricants = lubricants.filter(item => (Number(item.currentStock) || 0) < (Number(item.minStock) || 0));
    const lowItems = storeItems.filter(item => (Number(item.currentStock) || 0) < (Number(item.minStock) || 0));
    const totalReceipts = receipts.reduce((total, record) => total + (Number(record.amount) || 0), 0);
    const label = from + " to " + to;
    const lowStockNames = [
      ...lowLubricants.map(item => "Lubricant: " + cleanText(item.name, 100)),
      ...lowItems.map(item => "Store item: " + cleanText(item.name, 100))
    ];
    const lines = [
      "KETE KRACHI TIMBER RECOVERY — KKTR STORES SYSTEM",
      "STORES REPORT: " + label,
      "",
      "LUBRICANTS",
      "Issued transactions: " + lubeIssued.length + " | quantity: " +
        lubeIssued.reduce((total, record) => total + (Number(record.qty) || 0), 0),
      "Restock transactions: " + lubeRestocked.length + " | quantity: " +
        lubeRestocked.reduce((total, record) => total + (Number(record.qty) || 0), 0),
      "Current lubricant types: " + lubricants.length,
      "",
      "GENERAL STORES",
      "Items issued: " + itemsIssued.length + " | quantity: " +
        itemsIssued.reduce((total, record) => total + (Number(record.qty) || 0), 0),
      "Restock transactions: " + itemsRestocked.length + " | quantity: " +
        itemsRestocked.reduce((total, record) => total + (Number(record.qty) || 0), 0),
      "Current store-item types: " + storeItems.length,
      "",
      "OPERATIONS",
      "Requisitions in period: " + requisitions.length,
      "Receipts in period: " + receipts.length,
      "Total receipt amount in period: GH₵" + totalReceipts,
      "Low-stock records: " + lowStockNames.length,
      ...lowStockNames.slice(0, 100).map(name => "  " + name)
    ];
    if (lowStockNames.length > 100) {
      lines.push("  (First 100 low-stock names shown; the total count above includes all low-stock records.)");
    }
    finalDept = "Stores";
    finalPeriod = label;
    finalBody = lines.join("\n");
    finalSummary = {
      periodStart: from,
      periodEnd: to,
      lubeIssueTransactions: lubeIssued.length,
      lubeIssuedQuantity: lubeIssued.reduce((total, record) => total + (Number(record.qty) || 0), 0),
      lubeRestockTransactions: lubeRestocked.length,
      lubeRestockedQuantity: lubeRestocked.reduce((total, record) => total + (Number(record.qty) || 0), 0),
      storeIssueTransactions: itemsIssued.length,
      storeIssuedQuantity: itemsIssued.reduce((total, record) => total + (Number(record.qty) || 0), 0),
      storeRestockTransactions: itemsRestocked.length,
      storeRestockedQuantity: itemsRestocked.reduce((total, record) => total + (Number(record.qty) || 0), 0),
      requisitions: requisitions.length,
      receipts: receipts.length,
      totalReceipts,
      lowStockCount: lowStockNames.length,
      lubricantTypes: lubricants.length,
      storeItemTypes: storeItems.length
    };
  } else {
    if (!requestedBody.trim()) {
      fail("invalid-argument", "A general report requires non-empty body text.");
    }
    if (data.summary !== undefined && data.summary !== null) {
      if (typeof data.summary !== "object" || Array.isArray(data.summary)) {
        fail("invalid-argument", "Report summary must be an object.");
      }
      let summaryJson;
      try {
        summaryJson = JSON.stringify(data.summary);
      } catch {
        fail("invalid-argument", "Report summary is not valid JSON data.");
      }
      if (Buffer.byteLength(summaryJson || "{}", "utf8") > 20000) {
        fail("invalid-argument", "Report summary exceeds the 20,000-byte limit.");
      }
      finalSummary = data.summary;
    }
  }

  if (finalBody.length > 100000) {
    fail("resource-exhausted", "The generated report exceeds the 100,000-character limit.");
  }
  // Never trust sender identity or recipient fields supplied by the browser.
  const cooSnapshot = await db.collection("users").where("role", "==", "coo").get();
  const recipients = cooSnapshot.docs.filter(docSnap => {
    const candidate = docSnap.data();
    return candidate.approved === true && candidate.disabled !== true;
  });
  if (recipients.length > 400) {
    fail("resource-exhausted", "There are too many COO recipients to notify safely in one transaction.");
  }

  const actorName = cleanText(profile.name, 100) || uid;
  const reportRef = db.collection("reports").doc();
  const notificationRefs = recipients.map(recipient => ({
    uid: recipient.id,
    ref: db.collection("notifications").doc()
  }));
  const report = {
    type,
    title,
    body: finalBody,
    reportText: finalBody,
    dept: finalDept,
    from: actorName,
    fromRole: profile.role,
    submittedBy: actorName,
    submittedByUid: uid,
    fromDept: finalDept,
    period: finalPeriod,
    toRole: "coo",
    targetRole: "coo",
    targetDept: "Administration",
    summary: finalSummary,
    status: "submitted",
    createdByUid: uid,
    createdAt: FieldValue.serverTimestamp()
  };

  await db.runTransaction(async transaction => {
    transaction.create(reportRef, report);
    for (const recipient of notificationRefs) {
      transaction.create(recipient.ref, {
        type: "report",
        title: "New operational report",
        message: title,
        reportId: reportRef.id,
        toUserId: recipient.uid,
        toRole: "coo",
        targetRole: "coo",
        read: false,
        createdAt: FieldValue.serverTimestamp()
      });
    }
  });

  return { ok: true, reportId: reportRef.id, notificationRecipients: notificationRefs.length };
});

exports.approveAttendanceReportAndSendToCOO = onCall({ maxInstances: 5 }, async request => {
  const { uid, profile } = await getCallerProfile(request);
  if (profile.role !== "hr" || profile.approved !== true) {
    fail("permission-denied", "Only an approved HR account can approve an attendance report.");
  }

  const sourceId = cleanText(request.data && request.data.attendanceReportId, 150);
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(sourceId)) {
    fail("invalid-argument", "A valid attendance report ID is required.");
  }

  const sourceRef = db.collection("attendanceReports").doc(sourceId);
  const reportRef = db.collection("reports").doc("attendance-report-" + sourceId);
  const cooSnapshot = await db.collection("users").where("role", "==", "coo").get();
  const recipients = cooSnapshot.docs.filter(docSnap => {
    const candidate = docSnap.data();
    return candidate.approved === true && candidate.disabled !== true;
  });
  if (recipients.length > 400) {
    fail("resource-exhausted", "There are too many COO recipients to notify safely in one transaction.");
  }
  const actorName = cleanText(profile.name, 100) || uid;
  const notificationRefs = recipients.map(recipient => ({
    uid: recipient.id,
    ref: db.collection("notifications").doc()
  }));
  let alreadySubmitted = false;
  let recipientCount = recipients.length;

  await db.runTransaction(async transaction => {
    const [sourceSnap, existingReportSnap] = await Promise.all([
      transaction.get(sourceRef),
      transaction.get(reportRef)
    ]);
    if (!sourceSnap.exists) fail("not-found", "Attendance report was not found.");
    const source = sourceSnap.data();

    if (existingReportSnap.exists) {
      if (source.reportId === reportRef.id && source.reportSentToCOO === true) {
        alreadySubmitted = true;
        recipientCount = Number(source.notificationRecipients) || 0;
        return;
      }
      fail("already-exists", "An attendance report already uses this submission ID. An administrator must reconcile the records.");
    }
    if (!Array.isArray(source.summary)) {
      fail("failed-precondition", "The attendance report has no valid worker summary.");
    }
    if (source.summary.length > 2000) {
      fail("resource-exhausted", "The attendance report exceeds the safe worker-summary limit.");
    }
    if (source.status !== "pending" && source.status !== "approved") {
      fail("failed-precondition", "Only a pending or previously approved attendance report can be filed with the COO.");
    }

    const rows = source.summary.map(row => ({
      name: cleanText(row && row.name, 100) || "Unnamed worker",
      present: Number.isFinite(Number(row && row.present)) ? Number(row.present) : 0,
      absent: Number.isFinite(Number(row && row.absent)) ? Number(row.absent) : 0,
      chopMoney: Number.isFinite(Number(row && row.chopMoney)) ? Number(row.chopMoney) : 0
    }));
    const totalPresent = rows.reduce((total, row) => total + row.present, 0);
    const totalAbsent = rows.reduce((total, row) => total + row.absent, 0);
    const totalChopMoney = rows.reduce((total, row) => total + row.chopMoney, 0);
    const dept = cleanText(source.dept, 100) || "Unknown department";
    const period = cleanText(source.month || source.monthStart || source.period, 100) || "Unspecified period";
    const title = "Attendance Report — " + dept + " (" + period + ")";
    const body = [
      "KKTR ATTENDANCE REPORT",
      "Department: " + dept,
      "Period: " + period,
      "",
      ...rows.map(row => row.name + ": " + row.present + " present, " +
        row.absent + " absent; chop money GH₵" + row.chopMoney),
      "",
      "TOTALS: " + totalPresent + " present | " + totalAbsent +
        " absent | GH₵" + totalChopMoney + " chop money"
    ].join("\n");
    if (body.length > 100000) {
      fail("resource-exhausted", "The generated attendance report exceeds the 100,000-character limit.");
    }

    transaction.create(reportRef, {
      type: "attendance",
      title,
      period,
      dept,
      from: actorName,
      fromRole: profile.role,
      submittedBy: actorName,
      submittedByUid: uid,
      fromDept: "HR",
      toRole: "coo",
      targetRole: "coo",
      targetDept: "Administration",
      status: "submitted",
      summary: {
        dept,
        totalPresent,
        totalAbsent,
        totalChopMoney,
        workers: rows.length
      },
      body,
      reportText: body,
      sourceAttendanceReportId: sourceId,
      createdByUid: uid,
      createdAt: FieldValue.serverTimestamp()
    });

    for (const recipient of notificationRefs) {
      transaction.create(recipient.ref, {
        type: "report",
        title: "New attendance report",
        message: title,
        reportId: reportRef.id,
        toUserId: recipient.uid,
        toRole: "coo",
        targetRole: "coo",
        read: false,
        createdAt: FieldValue.serverTimestamp()
      });
    }

    transaction.update(sourceRef, {
      status: "approved",
      approvedBy: actorName,
      approvedByUid: uid,
      approvedAt: FieldValue.serverTimestamp(),
      reportSentToCOO: true,
      reportId: reportRef.id,
      reportSentAt: FieldValue.serverTimestamp(),
      notificationRecipients: notificationRefs.length
    });
  });

  return {
    ok: true,
    reportId: reportRef.id,
    notificationRecipients: recipientCount,
    alreadySubmitted
  };
});
