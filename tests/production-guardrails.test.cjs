const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "src/App.js"), "utf8");
const entry = fs.readFileSync(path.join(root, "src/index.js"), "utf8");
const serviceWorker = fs.readFileSync(path.join(root, "public/sw.js"), "utf8");

test("a missing administrator account fails closed instead of being created by login", () => {
  assert.match(app, /Administrator account is not provisioned/);
  assert.doesNotMatch(app, /await setDoc\(doc\(db,"users",ADMIN_USER\),adminDoc\)/);
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
  const end = app.indexOf("// ─── OFFLINE STOCK QUEUE", start);
  assert.ok(start >= 0 && end > start, "chat outbox section must exist");
  const queue = app.slice(start, end);
  assert.match(queue, /setDoc\(doc\(db,"chats",m\.thread,"messages",m\.id\)/);
  assert.match(queue, /const failed=new Set\(\)/);
  assert.match(queue, /Chat queue was not cleared/);
  assert.doesNotMatch(queue, /await addDoc\(collection\(db, "chats"/);
});

test("lubricant transactions are not falsely reported as committed while offline", () => {
  assert.doesNotMatch(app, /queueOffline\("transactions",txData\)/);
  assert.doesNotMatch(app, /Issued offline — will sync|Restocked offline — will sync/);
  assert.match(app, /Stock changes require a live connection to verify availability/);
});

test("offline stock queue persists stable IDs and retains failed writes", () => {
  const start = app.indexOf("const OFFLINE_STOCK_KEY");
  const end = app.indexOf("// Auto-sync when network returns", start);
  assert.ok(start >= 0 && end > start, "stock outbox section must exist");
  const queue = app.slice(start, end);
  assert.match(queue, /setDoc\(doc\(db,"storeItems",item\.id\)/);
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
