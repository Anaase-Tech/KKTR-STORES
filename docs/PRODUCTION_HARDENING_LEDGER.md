# KKTR Stores — Production Hardening Ledger

- **Project:** KKTR Stores Management System, Anaase-Tech / Kete Krachi Timber Recovery
- **Repository:** Anaase-Tech/KKTR-STORES
- **Baseline:** main at commit b0b13f924cadb42222f6b6315d717b365a1d6a27
- **Working branch:** hardening/phase-1-auth-pwa-ci
- **Started:** 25 October 2026 (Africa/Accra, UTC+0)
- **Status:** Phase-one changes prepared for automated verification; **not approved for production deployment**.

## Operating rule

No feature is called production-ready because a screen exists or a local write appears successful. A release must be supported by source review, repeatable automated checks, Firebase rules and identity verification, and real environment testing. Do not merge or deploy around a red quality gate. No test account, default password, fake delivery confirmation, or placeholder contact detail may be presented as live functionality.

## Phase-one change log

| When | Where | What changed | Why | How verified / owner |
|---|---|---|---|---|
| 2026-10-25 | src/App.js — LoginScreen | Removed automatic creation of the administrator document from an unauthenticated browser login. A missing administrator now fails closed with an explicit provisioning message. | The former path allowed the first login attempt to create a privileged account using whatever password the caller supplied if client writes were permitted. | Guardrail test added. Repository owner / authorized administrator must provision or migrate the real account using a reviewed server-side process. |
| 2026-10-25 | firebase_setup.js | Removed the committed setup utility that seeded an administrator with a fixed password using the client SDK. | Fixed credentials in a repository and client-side privileged account creation are not a secure production provisioning process. | File removed in this branch. If it was ever used, rotate the affected password and review Firebase access/audit history; Git history may retain old contents. |
| 2026-10-25 | src/App.js — COOAttendReport | Moved attSubmitting state initialization above the loading early return. | React hooks must execute in the same order on each render; the previous order could crash once loading completed. | Guardrail test added; build gate must pass. |
| 2026-10-25 | src/App.js — print export | Escaped report title/content before embedding in the print document. | Report text may include user-controlled data; raw interpolation into HTML can inject markup or script. | Guardrail test added. This remains browser print-to-PDF, not a persisted PDF artifact. |
| 2026-10-25 | src/index.js and src/App.js | Removed code that unregistered the service worker after public/index.html registered it. | The registration/unregistration conflict prevented reliable PWA/offline-shell behavior. | Guardrail test added. Real-device offline testing is still required. |
| 2026-10-25 | public/sw.js | Replaced stale logo/favicon cache paths with the actual icon192.png and icon512.png assets; rotated cache namespace. | The former cache.addAll list referenced files absent from public/, so one miss could prevent the shell list from caching. | Guardrail test checks the assets exist. Offline cold-start must still be tested on the deployed origin. |
| 2026-10-25 | .env, .gitignore, build/ | Removed the tracked environment file that disabled the ESLint plugin, ignored future local environment files/generated build output, and removed stale compiled output/source map from source control. | Production builds must not silently bypass linting; deploys should build from source rather than use a stale committed bundle. | CI workflow runs with CI=true and locked dependencies. Build result must be reviewed before merge. |
| 2026-10-25 | tests/production-guardrails.test.cjs and .github/workflows/quality-gate.yml | Added regression checks and a pull-request quality gate that installs from the lockfile, runs tests, and builds with CI lint enforcement. | Repeatable checks are required to prevent known defects from returning unnoticed. | GitHub Actions must complete successfully; these static guardrails are not an integration/security test suite. |

## Production blockers still open

These are not claimed to be fixed in phase one. Each must be closed with code, rules, evidence, and documentation before a production sign-off.

### P0 — Authentication and authorization

- The application still implements its own browser-side username/password hash/session flow instead of Firebase Authentication or a trusted server-side identity provider.
- Password hashes and role data remain in Firestore documents accessed by client code. A client-only UI check is not an authorization boundary.
- No versioned firestore.rules, database.rules.json, Storage rules, or Firebase project deployment configuration was present in the audited repository. The actual rules currently deployed in Firebase have **not** been verified here.
- Do not assume the database is safe because the new login path fails closed. Before production, implement Firebase Authentication, migrate accounts safely, write least-privilege Firestore/Realtime Database/Storage rules, test them in the Firebase Emulator Suite, and deploy only after an authorized review.
- The Firebase web configuration is still embedded in the client bundle. Firebase web config is not a server secret, but the API key must be appropriately restricted and all data access must be enforced by security rules. Validate that the app is pointed at the intended project rather than assuming the existing kktr-stores-test project is production.
- If the old firebase_setup.js ever ran, rotate the account credentials it set and review access history. Deleting a file does not erase its Git history.

### P0 — Build and release evidence

- This branch has not been merged or deployed.
- The independent local clone/build could not be run in the prior audit because the execution environment could not resolve github.com. The new GitHub Actions run is the first repeatable build check; record its actual result before sign-off.
- Do not deploy if npm ci, tests, linting, or the production build fails. Do not reintroduce CI=false or DISABLE_ESLINT_PLUGIN=true to force a green build; fix the underlying warnings/errors and document any justified exception.

### P1 — Offline inventory integrity and queued writes

- Firestore IndexedDB persistence helps cache reads and queue supported Firestore writes, but it does not make application-level multi-write workflows atomic.
- Stock changes currently involve separate inventory and ledger writes; the offline paths do not reliably queue the inventory delta and ledger as one idempotent business operation.
- Existing stock/chat queue sync paths can discard queued operations after individual write failures. Some queue entries use auto-generated document IDs, so retries can create duplicates.
- Implement a durable, versioned outbox with stable operation IDs, explicit pending/synced/failed states, retry/backoff, user-visible sync status, duplicate protection, and reconciliation. Make stock mutation plus ledger entry atomic in a trusted backend/transaction path. Test airplane-mode operation, app termination/restart, network recovery, duplicate delivery, and conflict handling on real devices.

### P1 — Reports, attendance, and chop money

- HR and Stores report writers/readers use inconsistent fields (toRole versus targetRole and body versus reportText), so COO report visibility/counts are inconsistent.
- The HR report error fallback is undermined by a helper that catches and swallows failures. Align one validated report schema, surface delivery failures, and persist a recoverable outbox entry before showing success.
- Weekly chop-money totals must include only HR-approved attendance records. Prevent duplicate weekly submissions and preserve approval/audit history.
- A browser print view is not a persisted PDF. A real PDF workflow must generate/store an artifact, save a verified storage path/URL, enforce access controls, and report upload/send failures honestly.
- Email and WhatsApp routing must use verified, configured contact details. No placeholder address/number should be shown as configured.

### P1 — Notifications and worker identity

- The current permission-only stub did not subscribe to Firebase Cloud Messaging or send push notifications; it has been removed rather than advertised as a working feature. Real push requires FCM web setup, token lifecycle, a messaging service worker, trusted server-side message sending, and tests while the app is closed.
- Worker duplicate checks are client-side and do not reliably handle old records without normalized keys or concurrent writes. Backfill data and enforce uniqueness in a transaction/server-side path.

## Release sequence (recommended)

1. **Security foundation:** confirm project/environment, deploy reviewed Firebase Authentication migration, least-privilege rules, server-side role checks, and emulator tests. Review/rotate any credentials created by the removed seed script.
2. **Build integrity:** obtain green GitHub Actions results with lint enabled; resolve all real errors without bypasses.
3. **Inventory correctness:** durable idempotent outbox and atomic stock/ledger workflow, with offline/online reconciliation tests.
4. **Business workflow correctness:** canonical report schema, approved-only chop-money calculations, duplicate-submission protection, reliable in-app notifications, and true stored PDFs.
5. **Operational messaging:** real FCM push and validated WhatsApp/email configuration.
6. **Acceptance testing:** role-by-role test matrix, real Firebase test project, deployed-origin PWA/offline tests, backups/restore drill, monitoring, and documented rollback.

## Roles and change control

- **Engineering implementer:** prepares each focused change, tests it, and records evidence in this ledger.
- **Project owner / authorized repository maintainer:** reviews the change, confirms business policy and production project access, approves merge and deployment.
- **Firebase/project administrator:** verifies deployed rules, identity migration, API-key restrictions, backups, and audit logs.
- **Stores, HR, COO, Department Heads:** participate in role-specific acceptance tests and sign off their own workflows before release.

## Current release decision

**NO-GO for production until the blockers above are closed.** This branch is a first hardening increment, not a claim that the whole application is production-ready. The workflow's actual result, rules emulator evidence, target Firebase project, and real-device testing must be recorded before changing that decision.
