"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} = require("@firebase/rules-unit-testing");
const {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch
} = require("firebase/firestore");

const projectId = "demo-kktr-rules";
const root = path.resolve(__dirname, "../..");
let env;

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: fs.readFileSync(path.join(root, "firestore.rules"), "utf8")
    }
  });
});

test.after(async () => {
  if (env) await env.cleanup();
});

test.beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    const accounts = [
      ["admin", { id: "admin", username: "admin", name: "Admin", role: "admin", dept: "Administration", approved: true }],
      ["hr", { id: "hr", username: "hr", name: "HR Officer", role: "hr", dept: "HR", approved: true }],
      ["coo", { id: "coo", username: "coo", name: "COO", role: "coo", dept: "Administration", approved: true }],
      ["stores", { id: "stores", username: "stores", name: "Stores Manager", role: "store_manager", dept: "Administration", approved: true }],
      ["yard-head", { id: "yard-head", username: "yard-head", name: "Yard Head", role: "dept", dept: "Log Yard", approved: true }],
      ["mill-head", { id: "mill-head", username: "mill-head", name: "Mill Head", role: "dept", dept: "Sawmill", approved: true }]
    ];
    for (const [id, profile] of accounts) {
      await setDoc(doc(db, "users", id), profile);
      await setDoc(doc(db, "accountDirectory", id), profile);
    }
    await setDoc(doc(db, "userCredentials", "yard-head"), {
      algorithm: "scrypt", salt: "private-salt", hash: "private-hash"
    });
    await setDoc(doc(db, "_securityRateLimits", "hashed-limit"), { count: 1 });
    await setDoc(doc(db, "settings", "company"), { logoUrl: "https://example.invalid/logo.png" });
    await setDoc(doc(db, "workers", "worker-yard"), {
      name: "Worker Yard", nameKey: "worker yard", dept: "Log Yard", type: "casual"
    });
    await setDoc(doc(db, "workers", "worker-mill"), {
      name: "Worker Mill", nameKey: "worker mill", dept: "Sawmill", type: "casual"
    });
    await setDoc(doc(db, "attendance", "pending-yard"), {
      workerId: "worker-yard", workerName: "Worker Yard", dept: "Log Yard",
      date: "2026-10-25", present: true, status: "pending", markedBy: "yard-head"
    });
    await setDoc(doc(db, "attendance", "pending-yard-2"), {
      workerId: "worker-yard", workerName: "Worker Yard", dept: "Log Yard",
      date: "2026-10-25", present: false, status: "pending", markedBy: "yard-head"
    });
    await setDoc(doc(db, "lubricants", "lube-1"), {
      name: "Hydraulic Oil", currentStock: 100, unit: "litres", minStock: 10
    });
    await setDoc(doc(db, "storeItems", "item-1"), {
      name: "Gloves", currentStock: 50, unit: "pairs", minStock: 5
    });
    await setDoc(doc(db, "receipts", "receipt-yard"), {
      dept: "Log Yard", recordedBy: "yard-head", vendor: "Local supplier"
    });
    await setDoc(doc(db, "receipts", "receipt-mill"), {
      dept: "Sawmill", recordedBy: "mill-head", vendor: "Local supplier"
    });
    await setDoc(doc(db, "chats", "Log Yard||admin", "messages", "msg-yard"), {
      text: "Internal message", dept: "Log Yard", role: "dept", from: "Log Yard", read: false
    });
    await setDoc(doc(db, "chats", "Sawmill||admin", "messages", "msg-mill"), {
      text: "Other department message", dept: "Sawmill", role: "dept", from: "Sawmill", read: false
    });
  });
});

function asUser(uid) {
  return env.authenticatedContext(uid).firestore();
}
function asAnonymous() {
  return env.unauthenticatedContext().firestore();
}

test("unauthenticated and ordinary users cannot read private credential material", async () => {
  await assertFails(getDoc(doc(asAnonymous(), "userCredentials", "yard-head")));
  await assertFails(getDoc(doc(asUser("admin"), "_securityRateLimits", "hashed-limit")));
  await assertFails(getDoc(doc(asUser("yard-head"), "userCredentials", "yard-head")));
  await assertFails(setDoc(doc(asUser("admin"), "userCredentials", "new"), { hash: "x" }));
});

test("profiles are self-readable only; admins use the safe account directory", async () => {
  await assertSucceeds(getDoc(doc(asUser("yard-head"), "users", "yard-head")));
  await assertFails(getDoc(doc(asUser("yard-head"), "users", "mill-head")));
  await assertFails(getDocs(collection(asUser("admin"), "users")));
  await assertSucceeds(getDocs(collection(asUser("admin"), "accountDirectory")));
  await assertFails(getDocs(collection(asUser("yard-head"), "accountDirectory")));
  await assertFails(updateDoc(doc(asUser("admin"), "users", "yard-head"), { role: "admin" }));
});

test("workers are private to HR/admin and each department", async () => {
  await assertSucceeds(getDoc(doc(asUser("yard-head"), "workers", "worker-yard")));
  await assertFails(getDoc(doc(asUser("yard-head"), "workers", "worker-mill")));
  await assertSucceeds(getDocs(collection(asUser("hr"), "workers")));
  await assertFails(setDoc(doc(asUser("yard-head"), "workers", "forbidden"), {
    name: "Not Allowed", nameKey: "not allowed", dept: "Log Yard", type: "casual"
  }));
});

test("HR alone approves attendance and department heads cannot rewrite approved records", async () => {
  await assertFails(updateDoc(doc(asUser("yard-head"), "attendance", "pending-yard"), {
    status: "approved", approvedBy: "yard-head", approvedAt: serverTimestamp()
  }));
  await assertSucceeds(updateDoc(doc(asUser("hr"), "attendance", "pending-yard-2"), {
    status: "approved", approvedBy: "hr", approvedAt: serverTimestamp()
  }));
  await assertFails(updateDoc(doc(asUser("yard-head"), "attendance", "pending-yard-2"), {
    status: "pending", present: true
  }));
});

test("stock balances cannot change without a same-transaction ledger record", async () => {
  const db = asUser("stores");
  await assertFails(updateDoc(doc(db, "lubricants", "lube-1"), {
    currentStock: 90, lastTransactionId: "unpaired", updatedAt: serverTimestamp()
  }));

  const batch = writeBatch(db);
  batch.update(doc(db, "lubricants", "lube-1"), {
    currentStock: 90, lastTransactionId: "tx-valid", updatedAt: serverTimestamp()
  });
  batch.set(doc(db, "transactions", "tx-valid"), {
    type: "lube", action: "issue", itemId: "lube-1", itemName: "Hydraulic Oil",
    qty: 10, unit: "litres", takenBy: "Worker Yard", dept: "Log Yard",
    issuedBy: "stores", date: "2026-10-25", createdAt: serverTimestamp()
  });
  await assertSucceeds(batch.commit());
});

test("a ledger record without a matching inventory update is denied", async () => {
  const db = asUser("admin");
  await assertFails(setDoc(doc(db, "transactions", "tx-without-stock"), {
    type: "lube", action: "issue", itemId: "lube-1", itemName: "Hydraulic Oil",
    qty: 10, unit: "litres", issuedBy: "admin", date: "2026-10-25",
    createdAt: serverTimestamp()
  }));
});

test("stock update and ledger quantity must agree exactly", async () => {
  const db = asUser("admin");
  const batch = writeBatch(db);
  batch.update(doc(db, "storeItems", "item-1"), {
    currentStock: 45, lastTransactionId: "tx-wrong-qty", updatedAt: serverTimestamp()
  });
  batch.set(doc(db, "transactions", "tx-wrong-qty"), {
    type: "store", action: "issue", itemId: "item-1", itemName: "Gloves",
    qty: 10, unit: "pairs", issuedBy: "admin", date: "2026-10-25",
    createdAt: serverTimestamp()
  });
  await assertFails(batch.commit());
});

test("receipts cannot be read across department boundaries", async () => {
  await assertSucceeds(getDoc(doc(asUser("yard-head"), "receipts", "receipt-yard")));
  await assertFails(getDoc(doc(asUser("yard-head"), "receipts", "receipt-mill")));
  await assertSucceeds(getDoc(doc(asUser("hr"), "receipts", "receipt-mill")));
});

test("department chat access is limited to that department's staff threads", async () => {
  await assertSucceeds(getDoc(doc(asUser("yard-head"), "chats", "Log Yard||admin", "messages", "msg-yard")));
  await assertFails(getDoc(doc(asUser("yard-head"), "chats", "Sawmill||admin", "messages", "msg-mill")));
  await assertSucceeds(getDoc(doc(asUser("admin"), "chats", "Sawmill||admin", "messages", "msg-mill")));
});

test("password reset requests cannot be forged or edited directly by clients", async () => {
  await assertFails(setDoc(doc(asUser("yard-head"), "passwordResets", "fake"), {
    userId: "yard-head", status: "pending"
  }));
  await assertFails(setDoc(doc(asUser("admin"), "passwordResets", "fake-admin"), {
    userId: "yard-head", status: "pending"
  }));
});
