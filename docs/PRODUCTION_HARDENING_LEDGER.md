# KKTR Stores — Production Hardening Ledger

- **Project:** KKTR Stores Management System, Anaase-Tech / Kete Krachi Timber Recovery
- **Repository:** Anaase-Tech/KKTR-STORES
- **Baseline:** main at commit b0b13f924cadb42222f6b6315d717b365a1d6a27
- **Working branch:** hardening/phase-1-auth-pwa-ci
- **Started:** 25 October 2026 (Africa/Accra, UTC+0)
- **Status (2026-10-25):** Earlier commit `9b8094ca1aef4f45b832e1c104fc8ab5ae66b37e` passed the original 12-test/build gate. The branch now contains additional authentication/rules and reporting changes, including 21 static guardrail tests. Vercel caught a duplicate `async` syntax error, then the next build exposed two lint failures (unused `deleteDoc` and an unstable `showToast` dependency); these were corrected in commits `0475cf0ac059ffe84dec73db697375e06488f593` and `53240b19ecc0f0fc4b5080930109c886ecd26058`. The latest build result remains **unconfirmed**. Current release status remains **NO-GO**. The branch is also two commits behind `main`; reconcile and re-test before merge.

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
| 2026-10-25 | tests/production-guardrails.test.cjs and .github/workflows/quality-gate.yml | Added 12 static regression checks and a pull-request quality gate that runs clean installation, dependency audit capture, tests, and build with CI lint enforcement. | Repeatable checks are required to prevent known defects from returning unnoticed. | Run 40193140852 passed on commit 9b8094ca1aef4f45b832e1c104fc8ab5ae66b37e. The audit JSON files are uploaded as a short-retention workflow artifact. These are not Firebase integration/security tests. |

| 2026-10-25 | src/App.js — ChatThread and offline outbox | Added an actual toast state for chat access guards, stable message IDs, repeatable setDoc writes, and queue retention after failed sync attempts. | The old undefined showToast blocked production compilation, and the old chat queue could discard every queued message when one write failed. | Guardrails assert stable IDs and retention. CI build and real connection-loss testing are still required. |
| 2026-10-25 | src/App.js — lubricant transaction handler and stock outbox | Prevented lubricant stock from being shown as issued/restocked offline when the Firestore transaction never committed; made new-item/ledger queue retries preserve failures and use stable document IDs. | A ledger-only queued record and optimistic balance would create false inventory state. | Guardrails assert offline stock is not falsely confirmed. Online transaction/ledger atomicity remains open. |
| 2026-10-25 | src/App.js — AttendanceModule.submitWeekly | The weekly chop-money calculation now counts only HR-approved present days, checks legacy same-week submissions, and uses a deterministic document ID guarded by a Firestore transaction. | Prevent payments being computed from pending attendance and reduce duplicate weekly submissions. | Static guardrail added; integration verification against real records/rules still required. |

| 2026-10-25 | scripts/summarize-npm-audit.cjs and .github/workflows/quality-gate.yml | Added full and `--omit=dev` npm audit JSON capture, a human-readable summary, and a downloadable audit artifact. | Security risks must be visible and reviewed instead of suppressed or guessed. | Run 40193140852 reported 65 findings (10 low, 18 moderate, 34 high, 3 critical) in both summaries. The equal counts arise because `react-scripts`/Create React App is listed under production dependencies; they are not evidence that every finding affects shipped client code. Advisory triage and migration off the obsolete build tool remain open. |

## Phase-two change log — reporting integrity

| When | Where | What changed | Why | How verified / owner |
|---|---|---|---|---|
| 2026-10-25 | `src/App.js` — shared `sendInAppReport` | Report and notification documents are written in one Firestore transaction. Report records now carry both `toRole` and `targetRole` for compatibility, plus `submittedBy`, `fromDept`, and `period`. Write failures propagate to the caller instead of being swallowed. | Previously, the helper could swallow a failed write while the UI showed success; the report inbox queried a different recipient field than HR wrote. | Added a regression guard in `tests/production-guardrails.test.cjs`. Current commit must pass CI and the workflow must be tested with HR, Stores, and COO accounts in the Firebase Emulator Suite and a controlled Firebase project. |
| 2026-10-25 | `src/App.js` — HR report delivery | Removed hard-coded placeholder WhatsApp/email contacts. In-app report submission remains available; external delivery is explicitly reported as unavailable until a verified contact is configured. UI copy distinguishes opening an external app from actual delivery. | A placeholder number/address must never be presented as a working destination, and opening WhatsApp/email is not proof of delivery. | Regression guard asserts the known placeholder values are absent. Authorized administrator must supply and verify approved contact details before external delivery can be enabled. |
| 2026-10-25 | `src/App.js` — CI lint | Vercel's next build reported an unused `deleteDoc` import and a missing `showToast` effect dependency. Removed the unused import and stabilized the toast callback with React `useCallback` instead of disabling ESLint. | Vercel build log for commit `0475cf0ac059ffe84dec73db697375e06488f593`; verify the follow-up build and all guardrail/emulator tests. |
| 2026-10-25 | `src/App.js` — report helper syntax | A Vercel build caught `async async function sendInAppReport` (syntax error at line 45); corrected it to a single `async` declaration in commit `0475cf0ac059ffe84dec73db697375e06488f593`. | The first report patch accidentally duplicated the async modifier because the original declaration already had one. | Latest Vercel deployment was still building when checked; confirm final build status and rerun all 21 guardrails before merging. |
| 2026-10-25 | `src/App.js` — COO report detail | Detail view renders report content from `body`, `text`, or `reportText`, preserving visibility for HR records and legacy schemas. | The previous display condition only checked `reportText`, so reports that contained only `body` could show blank detail content. | Regression guard checks all supported body fields; verify with real HR and Stores records before release. |

## Production blockers still open

These are not claimed to be fixed in phase one. Each must be closed with code, rules, evidence, and documentation before a production sign-off.

### P0 — Authentication and authorization

- **Implemented in the hardening branch; not yet production-approved:** the browser login calls the `authenticateUser` HTTPS callable and signs in with a Firebase custom token. New password credentials use salted scrypt on the server; the legacy SHA-256 verifier exists only to migrate old credentials after a successful check. The backend contains account lifecycle callables for registration/approval, password reset/change, role changes, account listing/deletion, and worker administration.
- The server checks the caller's Firebase identity, active profile, role, approval state, and session version for privileged operations. Review each callable and every authorization branch before deployment; passing static tests does not prove the policy is complete.
- Versioned `firestore.rules`, `storage.rules`, and `firebase.json` now exist on this branch. Firestore rules deny direct client writes to user profiles, credential records, worker records, rate-limit records, and worker-name keys; business collections have role-scoped rules. The quality workflow defines Firestore Emulator Suite tests. The current revision's actual CI result must be checked before merge, and deployed Firebase rules have **not** been independently read or verified.
- The Firebase web configuration remains in the client bundle. It is not a server secret, but API-key restrictions and data access controls must be verified. Confirm the intended Firebase project before deploying; do not assume `kktr-stores-test` is production.
- The removed `firebase_setup.js` may remain in Git history. If it was ever run, rotate affected credentials and inspect access history. Account migration must be rehearsed against a controlled copy of real records, with rollback and audit evidence.


### P0 — Build and release evidence

- This branch has not been merged or deployed.
- GitHub Actions run 40193140852 passed on commit 9b8094ca1aef4f45b832e1c104fc8ab5ae66b37e: `npm ci`, the 12 regression guardrail tests, both audit reports/artifact upload, and `npm run build` with `CI=true` and ESLint enforcement. See https://github.com/Anaase-Tech/KKTR-STORES/actions/runs/40193140852. This is a CI build result, not a Firebase integration test or production acceptance test.
- Earlier CI runs exposed a stale TypeScript lockfile entry, an undefined showToast reference, unused variables/imports, and a mixed-operator warning. The lock and source were repaired rather than bypassing lint. Keep the quality gate enabled.

### P1 — Dependency supply-chain risk

- CI run [40193140852](https://github.com/Anaase-Tech/KKTR-STORES/actions/runs/40193140852) reported 65 findings (10 low, 18 moderate, 34 high, 3 critical). The same count appeared in `npm audit --omit=dev` because this repository lists `react-scripts` under production `dependencies`, so the omit flag does not remove it. This does **not** prove all vulnerabilities are exploitable in browser runtime; it shows the dependency tree needs an explicit, package-by-package triage.
- The direct `react-scripts` dependency is a high severity root for multiple transitive findings and the recommended fix from npm requires a major toolchain change. Create React App is deprecated. The next remediation should migrate the build pipeline to a maintained toolchain such as Vite in a separate checked stage, regenerate the lockfile on a network-enabled runner, and preserve current PWA behavior. Do not run `npm audit fix --force`, downgrade the audit gate, or treat toolchain migration as complete until build and browser smoke tests pass.
- The audit artifact has a seven-day retention policy; download it from the workflow run for the full advisory listing. Re-run audit after remediation and document any residual risk explicitly.

### P1 — Offline inventory integrity and queued writes

- Firestore IndexedDB persistence helps cache reads and queue supported Firestore writes, but it does not make application-level multi-write workflows atomic.
- Lubricant issue/restock now fails closed while offline rather than changing the displayed stock and queuing only a ledger row. This prevents false success but means lubricant mutations are not available offline. Stock quantity changes and ledger entries also remain separate writes online and are not yet an atomic business operation.
- The browser-side chat and new-item queues now use stable document IDs for retries and retain per-item failures instead of clearing the entire queue after a failed write. They still use localStorage, can be lost if browser storage is cleared/unavailable, and do not yet expose a complete pending/synced/failed operational queue view.
- A newly queued stock item is explicitly described as queued and is not available to issue until synchronization succeeds. Implement durable IndexedDB outbox storage, observable pending/synced/failed states, retry/backoff, a user-visible sync view, and reconciliation. Make each stock mutation plus ledger entry atomic in a trusted backend/transaction path. Test airplane-mode operation, app termination/restart, network recovery, duplicate delivery, and conflict handling on real devices.

### P1 — Reports, attendance, and chop money

- The shared HR report writer now writes both `toRole` and `targetRole`, plus `submittedBy`, `fromDept`, and `period`; the COO inbox subscribes to report changes in real time and accepts either recipient field for legacy records. The COO dashboard count also includes either field. The detail view reads `body`, `text`, or `reportText`.
- Report and notification writes are now one Firestore transaction, and write errors propagate rather than being swallowed. The UI no longer claims an external message was delivered merely because WhatsApp/email opened. The offline report outbox is **not** implemented yet: offline submission must fail visibly until a durable, idempotent outbox is built and tested.
- Weekly chop-money calculation on this branch now counts only records with status=approved and uses a deterministic department/week document ID inside a Firestore transaction. It also checks for legacy records for the same week before submission. These changes still need integration tests against deployed security rules and existing production data; preserve approval/audit history.
- A browser print view is not a persisted PDF. A real PDF workflow must generate/store an artifact, save a verified storage path/URL, enforce access controls, and report upload/send failures honestly.
- Email and WhatsApp routing must use verified, configured contact details. No placeholder address/number should be shown as configured.

### P1 — Notifications and worker identity

- The current permission-only stub did not subscribe to Firebase Cloud Messaging or send push notifications; it has been removed rather than advertised as a working feature. Real push requires FCM web setup, token lifecycle, a messaging service worker, trusted server-side message sending, and tests while the app is closed.
- Worker duplicate checks are client-side and do not reliably handle old records without normalized keys or concurrent writes. Backfill data and enforce uniqueness in a transaction/server-side path.

## Release sequence (recommended)

1. **Security verification:** review the new callable authentication/account lifecycle code and least-privilege Firestore/Storage rules; get a green current CI run including emulator tests; verify actual deployed rules and intended Firebase project; rehearse account migration and recovery.
2. **Build and dependency integrity:** obtain green GitHub Actions results with lint enabled; triage all 65 previously reported dependency findings and migrate from the deprecated Create React App toolchain in a separate tested change.
3. **Inventory correctness:** durable idempotent IndexedDB outbox and atomic stock/ledger workflow, with offline/online reconciliation tests.
4. **Business workflow correctness:** verify the new canonical report writes with HR/Stores/COO accounts, finish the notification routing, preserve approved-only chop-money calculations, and generate real stored PDF artifacts.
5. **Operational messaging:** real FCM push, verified WhatsApp/email configuration, and truthful delivery status.
6. **Acceptance testing:** role-by-role test matrix, controlled Firebase project, deployed-origin PWA/offline tests, backups/restore drill, monitoring, and documented rollback.

## Roles and change control

- **Engineering implementer:** prepares each focused change, tests it, and records evidence in this ledger.
- **Project owner / authorized repository maintainer:** reviews the change, confirms business policy and production project access, approves merge and deployment.
- **Firebase/project administrator:** verifies deployed rules, identity migration, API-key restrictions, backups, and audit logs.
- **Stores, HR, COO, Department Heads:** participate in role-specific acceptance tests and sign off their own workflows before release.

## Current release decision

**NO-GO for production until the blockers above are closed.** This branch is a first hardening increment, not a claim that the whole application is production-ready. The workflow's actual result, rules emulator evidence, target Firebase project, and real-device testing must be recorded before changing that decision.
