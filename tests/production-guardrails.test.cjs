const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "src/App.js"), "utf8");
const entry = fs.readFileSync(path.join(root, "src/index.js"), "utf8");
const serviceWorker = fs.readFileSync(path.join(root, "public/sw.js"), "utf8");

test("browser sign-in delegates credentials to Firebase Auth callables", () => {
  assert.match(app, /callBackend\("authenticateUser"/);
  assert.match(app, /signInWithCustomToken\(auth,payload\.token\)/);
  assert.match(app, /onAuthStateChanged\(auth/);
  assert.doesNotMatch(app, /async function hashPwd\(/);
  assert.doesNotMatch(app, /cached\.pwdHash===pwdHash/);
  assert.doesNotMatch(app, /await setDoc\(doc\(db,"users",ADMIN_USER\),adminDoc\)/);
});

test("account registration and password lifecycle use server-side callables", () => {
  for (const name of ["registerDepartmentHead","requestPasswordReset","approveDepartmentHead","deleteAccount","resetUserPassword","changeOwnPassword","setAccountRole"]) {
    assert.match(app, new RegExp('callBackend\\("' + name + '"'));
  }
  assert.doesNotMatch(app, /await updateDoc\(doc\(db,"users",target\.id\)/);
});

test("cached session profiles exclude credential fields", () => {
  assert.match(app, /delete safe\.pwdHash/);
  assert.match(app, /delete safe\.pendingPasswordReset/);
  assert.match(app, /if\(!navigator\.onLine&&cachedMatches\)/);
  assert.match(app, /await signOut\(auth\)/);
});

test("application code does not unregister the PWA service worker", () => {
  assert.doesNotMatch(app + "\n" + entry, /serviceWorker\.getRegistrations\(\)[\s\S]{0,300}\.unregister\(\)/);
});

test("COO attendance hooks are declared before the loading early return", () => {
  const start = app.indexOf("function COOAttendReport(");
  assert.notEqual(start, -1, "COO attendance report component must exist");
  const nextFunction = app.indexOf("\nfunction ", start + 1);
  const component = app.slice(start, nextFunction === -1 ? app.length : nextFunction);
  const hook = component.indexOf("const [attSubmitting,setAttSubmitting]=useState(false)");
  const earlyReturn = component.indexOf("if(loading) return");
  assert.ok(hook >= 0, "attendance submitting hook must exist");
  assert.ok(earlyReturn >= 0, "loading early return must exist");
  assert.ok(hook < earlyReturn, "hooks must execute in the same order on every render");
});

test("report title and content are HTML-escaped before printing", () => {
  assert.match(app, /function escapeHTML\(value\)/);
  assert.match(app, /<title>\$\{escapeHTML\(title\)\}<\/title>/);
  assert.match(app, /<h1>\$\{escapeHTML\(title\)\}<\/h1>/);
  assert.match(app, /<pre>\$\{escapeHTML\(content\)\}<\/pre>/);
});

test("report creation uses a trusted server callable and private recipient fan-out", () => {
  const functionsSource = fs.readFileSync(path.join(root, "functions/index.js"), "utf8");
  const rules = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");
  assert.match(app, /callBackend\("submitReportToCOO"/);
  assert.doesNotMatch(app, /addDoc\(collection\(db,"reports"\)/);
  assert.match(functionsSource, /exports\.submitReportToCOO = onCall/);
  assert.match(functionsSource, /transaction\.create\(reportRef, report\)/);
  assert.match(functionsSource, /toUserId: recipient\.uid/);
  assert.match(functionsSource, /createdByUid: uid/);
  const reportRuleStart = rules.indexOf("match /reports/{id}");
  const reportRuleEnd = rules.indexOf("match /notifications/{id}", reportRuleStart);
  const reportRule = rules.slice(reportRuleStart, reportRuleEnd);
  assert.match(reportRule, /allow create: if false/);
  assert.match(rules, /resource\.data\.keys\(\)\.hasAny\(\['toUserId'\]\)/);
});

test("attendance, chop-money, and Stores reports derive operational values from Firebase records", () => {
  const functionsSource = fs.readFileSync(path.join(root, "functions/index.js"), "utf8");
  assert.match(functionsSource, /db\.collection\("attendanceReports"\)[\s\S]{0,100}where\("status", "==", "approved"\)/);
  assert.match(functionsSource, /db\.collection\("chopMoney"\)\.get\(\)/);
  assert.match(functionsSource, /db\.collection\("transactions"\)\.get\(\)/);
  assert.match(functionsSource, /db\.collection\("receipts"\)\.get\(\)/);
  assert.match(functionsSource, /const range = data\.range \|\| \{\}/);
  assert.match(app, /range:\{from:f2,to:t2\}/);
  const storesStart = app.indexOf("const submitToCOO=async()=>");
  const storesEnd = app.indexOf("if(loading) return", storesStart);
  const storesSubmit = app.slice(storesStart, storesEnd);
  assert.doesNotMatch(storesSubmit, /summary:/);
  assert.doesNotMatch(storesSubmit, /body:buildStoresReport\(\)/);
});

test("HR attendance approval and COO filing are atomic and safely retryable", () => {
  const functionsSource = fs.readFileSync(path.join(root, "functions/index.js"), "utf8");
  assert.match(app, /callBackend\("approveAttendanceReportAndSendToCOO"/);
  assert.doesNotMatch(app, /addDoc\(collection\(db,"reports"\)/);
  assert.match(functionsSource, /exports\.approveAttendanceReportAndSendToCOO = onCall/);
  assert.match(functionsSource, /transaction\.update\(sourceRef/);
  assert.match(functionsSource, /transaction\.create\(reportRef,/);
  assert.match(functionsSource, /reportSentToCOO: true/);
  assert.match(functionsSource, /source\.reportId === reportRef\.id && source\.reportSentToCOO === true/);
});

test("COO report delivery uses a consistent schema and does not claim failed writes succeeded", () => {
  const start = app.indexOf("async function sendInAppReport(");
  const end = app.indexOf("// ─── PDF EXPORT", start);
  assert.ok(start >= 0 && end > start, "shared report writer must exist");
  const writer = app.slice(start, end);
  assert.match(writer, /transaction\.set\(reportRef/);
  assert.match(writer, /targetRole:toRole/);
  assert.match(writer, /toRole,/);
  assert.match(writer, /submittedBy:from/);
  assert.match(writer, /period,/);
  assert.match(writer, /transaction\.set\(notificationRef/);
  assert.doesNotMatch(writer, /catch\s*\(/, "report write errors must reach the caller");
  const cooStart = app.indexOf("function COOHRReport(");
  const cooEnd = app.indexOf("\nfunction ", cooStart + 1);
  const coo = app.slice(cooStart, cooEnd < 0 ? app.length : cooEnd);
  assert.match(coo, /onSnapshot\(collection\(db,"reports"\)/);
  assert.match(coo, /r\.targetRole==="coo"\|\|r\.toRole==="coo"/);
  assert.match(coo, /detail\.body\|\|detail\.text\|\|detail\.reportText/);
  const dashboardStart = app.indexOf("function COODashboard(");
  const dashboardEnd = app.indexOf("\nfunction ", dashboardStart + 1);
  const dashboard = app.slice(dashboardStart, dashboardEnd < 0 ? app.length : dashboardEnd);
  assert.match(dashboard, /r\.targetRole==="coo"\|\|r\.toRole==="coo"/);
  assert.doesNotMatch(app, /233XXXXXXXXX|coo@kktr\.com/);
  assert.match(app, /delivery is unavailable until an authorized administrator configures and verifies/);
});


test("offline attendance retries are stable, idempotent, JSON-safe, and preserve failures", () => {
  const start = app.indexOf("function queueOffline(");
  const end = app.indexOf("// ─── OFFLINE CHAT QUEUE", start);
  assert.ok(start >= 0 && end > start, "attendance queue engine must exist");
  const queue = app.slice(start, end);
  assert.match(queue, /collectionName !== "attendance"/);
  assert.match(queue, /existing\.data\._docId === data\._docId/);
  assert.match(queue, /const target = doc\(db, "attendance", documentId\)/);
  assert.match(queue, /await setDoc\(target, \{ \.\.\.payload, createdAt: serverTimestamp\(\) \}\)/);
  assert.match(queue, /remaining\.push\(item\)/);
  assert.doesNotMatch(queue, /await addDoc\(collection\(db, item\.collection\)/);
  assert.doesNotMatch(queue, /getDocFromServer\(target\)/);
  assert.match(app, /queueOffline\("attendance",\{\.\.\.data,createdAt:new Date\(\)\.toISOString\(\),_docId:docId\}\)/);
  assert.match(app, /const transientNetworkFailure=!navigator\.onLine/);
});

test("service-worker shell refers to real public icon files", () => {
  const match = serviceWorker.match(/const SHELL_URLS = \[([\s\S]*?)\];/);
  assert.ok(match, "service-worker shell URL list must exist");
  const shell = match[1];
  assert.match(shell, /"\/icon192\.png"/);
  assert.match(shell, /"\/icon512\.png"/);
  assert.doesNotMatch(shell, /logo192\.png|logo512\.png|favicon\.ico/);
  for (const url of ["/index.html", "/manifest.json", "/icon192.png", "/icon512.png"]) {
    assert.ok(fs.existsSync(path.join(root, "public", url.slice(1))), "missing shell asset: " + url);
  }
});

test("unsafe bootstrap script and build-bypass environment file are absent", () => {
  assert.equal(fs.existsSync(path.join(root, "firebase_setup.js")), false);
  assert.equal(fs.existsSync(path.join(root, ".env")), false);
});


test("chat sync writes to stable message IDs and does not drop failed messages", () => {
  const start = app.indexOf("const OFFLINE_CHAT_KEY");
  const end = app.indexOf("const OFFLINE_STOCK_KEY", start);
  assert.ok(start >= 0 && end > start, "chat outbox section must exist");
  const queue = app.slice(start, end);
  assert.match(queue, /setDoc\(messageRef,/);\n  assert.match(queue, /getDoc\(messageRef,\{source:"server"\}\)/);
  assert.match(queue, /const failed=new Set\(\)/);
  assert.match(queue, /Chat queue was not cleared/);
  assert.doesNotMatch(queue, /await addDoc\(collection\(db, "chats"/);
});

test("lubricant transactions are not falsely reported as committed while offline", () => {
  assert.doesNotMatch(app, /queueOffline\("transactions",txData\)/);
  assert.doesNotMatch(app, /Issued offline — will sync|Restocked offline — will sync/);
  assert.match(app, /Stock changes require a live connection to (?:verify availability|commit the balance and ledger together)/);
});

test("offline stock queue persists stable IDs and retains failed writes", () => {
  const start = app.indexOf("const OFFLINE_STOCK_KEY");
  const end = app.indexOf("// Auto-sync when network returns", start);
  assert.ok(start >= 0 && end > start, "stock outbox section must exist");
  const queue = app.slice(start, end);
  assert.match(queue, /setDoc\(itemRef,/);\n  assert.match(queue, /getDoc\(itemRef,\{source:"server"\}\)/);
  assert.match(queue, /const completed=new Set\(\)/);
  assert.match(queue, /const failed=new Set\(\)/);
  assert.match(queue, /if\(remaining\.length\) localStorage\.setItem/);
});

test("weekly chop-money submission includes approved days only and prevents duplicate week records", () => {
  const start = app.indexOf("const submitWeekly=async()=>{");
  const end = app.indexOf("const submitMonthly=async()=>{", start);
  assert.ok(start >= 0 && end > start, "weekly submission handler must exist");
  const weekly = app.slice(start, end);
  assert.match(weekly, /if\(r\.status!=="approved"\) return/);
  assert.match(weekly, /const submissionId=/);
  assert.match(weekly, /await runTransaction\(db,async\(transaction\)/);
  assert.match(weekly, /transaction\.set\(submissionRef/);
  assert.match(weekly, /already exists for this week/);
});

test("chat component defines and renders its own access-control toast", () => {
  const start = app.indexOf("function ChatThread(");
  const end = app.indexOf("\nfunction ", start + 1);
  const component = app.slice(start, end);
  assert.match(component, /const \[toastEl,showToast\]=useToast\(\)/);
  assert.match(component, /\{toastEl\}/);
  assert.doesNotMatch(component, /showToast&&showToast/);
});


test("dependency audit summarizer emits findings from npm's JSON report", () => {
  const os = require("node:os");
  const { spawnSync } = require("node:child_process");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kktr-audit-test-"));
  const fixture = path.join(directory, "audit.json");
  try {
    fs.writeFileSync(fixture, JSON.stringify({
      metadata: { vulnerabilities: { total: 1, critical: 1, high: 0, moderate: 0, low: 0, info: 0 } },
      vulnerabilities: {
        "sample-vulnerable-package": {
          severity: "critical",
          isDirect: false,
          range: "<1.2.3",
          fixAvailable: true,
          via: [{ title: "Example advisory", url: "https://example.invalid/advisory" }]
        }
      }
    }));
    const script = path.join(root, "scripts", "summarize-npm-audit.cjs");
    const result = spawnSync(process.execPath, [script, fixture], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /critical/);
    assert.match(result.stdout, /sample-vulnerable-package/);
    assert.match(result.stdout, /Example advisory/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("server credential storage uses scrypt and legacy hashes are migration-only", () => {
  const passwordHelpers = fs.readFileSync(path.join(root, "functions/src/passwords.js"), "utf8");
  const functionsSource = fs.readFileSync(path.join(root, "functions/index.js"), "utf8");
  assert.match(passwordHelpers, /algorithm: "scrypt"/);
  assert.match(passwordHelpers, /timingSafeEqual/);
  assert.match(functionsSource, /collection\("userCredentials"\)/);
  assert.match(functionsSource, /verifyLegacyPassword/);
  assert.match(functionsSource, /pwdHash: FieldValue\.delete\(\)/);
  assert.doesNotMatch(functionsSource, /return\s+\{[^}]*pwdHash:/);
});

test("password reset and login endpoints are rate-limited and avoid username enumeration", () => {
  const functionsSource = fs.readFileSync(path.join(root, "functions/index.js"), "utf8");
  assert.match(functionsSource, /assertRateLimit\("login"/);
  assert.match(functionsSource, /assertRateLimit\("password-reset"/);
  assert.match(functionsSource, /Do not reveal whether a given username exists/);
  assert.match(functionsSource, /Too many attempts/);
});

test("factory reset cannot directly delete production records from the browser", () => {
  const settingsStart = app.indexOf("function SettingsModule(");
  const settingsEnd = app.indexOf("// ─── ERROR BOUNDARY", settingsStart);
  const settings = app.slice(settingsStart, settingsEnd);
  assert.match(settings, /Factory reset is disabled/);
  assert.equal(settings.includes('"attendanceReports","attendance","passwordResets",'), false);
});


test("account settings effect declares its stable toast dependency", () => {
  const start = app.indexOf("function SettingsModule(");
  const end = app.indexOf("// ─── ERROR BOUNDARY", start);
  const settings = app.slice(start, end);
  assert.match(app, /const show=useCallback\(\(m,k="ok"\)/);
  assert.match(settings, /\},\[user,showToast\]\);/);
});

test("Storage receipt object rules match uploaded .jpg paths and receive emulator coverage", () => {
  const storageRules = fs.readFileSync(path.join(root, "storage.rules"), "utf8");
  const securityTests = fs.readFileSync(path.join(root, "tests/security/rules.test.cjs"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/quality-gate.yml"), "utf8");
  assert.ok(storageRules.includes("match /receipts/{receiptObject}"));
  assert.ok(storageRules.includes("receiptObject.split("));
  assert.match(storageRules, /function isReceiptImage\(receiptObject\)/);
  assert.ok(app.includes("receipts/" + "$" + "{docRef.id}" + ".jpg"));
  assert.match(securityTests, /receipt image paths enforce department access/);
  assert.match(securityTests, /env\.clearStorage\(\)/);
  assert.match(workflow, /--only firestore,storage/);
});


test("account administration uses the sanitized live directory, never raw profile-list reads", () => {
  assert.match(app, /callBackend\("listAccounts",\{\}\)/);
  assert.match(app, /collection\(db,"accountDirectory"\)/);
  assert.doesNotMatch(app, /onSnapshot\(collection\(db,"users"\)/);
});

test("worker changes use HR-authorized callables with server-enforced normalized uniqueness", () => {
  const functionsSource = fs.readFileSync(path.join(root, "functions/index.js"), "utf8");
  const workerHelpers = fs.readFileSync(path.join(root, "functions/src/workers.js"), "utf8");
  assert.match(app, /callBackend\("addWorker"/);
  assert.match(app, /callBackend\("deleteWorker"/);
  assert.match(functionsSource, /exports\.addWorker = onCall/);
  assert.match(functionsSource, /exports\.deleteWorker = onCall/);
  assert.match(functionsSource, /normalizeWorkerName\(item\.data\(\)\.name\) === worker\.nameKey/);
  assert.match(workerHelpers, /normalizeWorkerName/);
  assert.match(fs.readFileSync(path.join(root, "firestore.rules"), "utf8"), /match \/workerNameKeys\/\{id\}[\s\S]*?allow read, write: if false/);
});

test("security rule configuration explicitly protects Firestore and Storage", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "firebase.json"), "utf8"));
  assert.equal(config.firestore.rules, "firestore.rules");
  assert.equal(config.storage.rules, "storage.rules");
  const rules = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");
  assert.match(rules, /match \/userCredentials\/\{id\} \{ allow read, write: if false; \}/);
  assert.match(rules, /match \/transactions\/\{id\}[\s\S]*?allow update, delete: if false/);
  assert.match(rules, /function pairedStockChange/);
});
