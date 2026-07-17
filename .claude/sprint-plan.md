# ContextReply Sprint Plan
_Last updated: 2026-06-07_

## Decisions locked
- TDLib (Telegram): **deferred** — not in active sprints
- AccessibilityService: **bundled with IME** (Sprint 2) — single Play Store declaration
- Cloud sync: **off by default** (opt-in)
- iOS keyboard extension: **deferred** — Android first
- EAS build limit resets: **July 1, 2026**

---

## Current State

| Area | Status |
|---|---|
| App opens, Claude suggestions, Maps ETA, Calendar | ✅ Working |
| Notification filtering (5 gates) | ✅ Committed — not yet built |
| Per-conversation IDs + 2.5s debounce | ✅ Committed — not yet built |
| NotificationStore (conversation accumulation) | ✅ Committed — not yet built |
| Live GPS, SQLite schema, Worker intent detection | ✅ Committed — not yet built |
| EAS build limit | ❌ Blocked until July 1, 2026 |
| ColorOS Notification Access for sideloaded apps | ❌ Blocked until Play Store publish |

---

## Sprint 0 — Stabilise & Validate
**Goal:** Get all committed but unbuilt changes onto a real device and confirm the core notification path works end-to-end.
**Blocked until:** July 1, 2026 (EAS reset). Code changes can be written now.

| # | Deliverable | Size |
|---|---|---|
| 0.1 | EAS build + APK install via SAI | S |
| 0.2 | Grant Notification Access via ADB (`adb shell cmd notification allow_listener`) | S |
| 0.3 | End-to-end test: WhatsApp message → suggestion notification → send reply | M |
| 0.4 | Wire `recordStyleEdit()` into `ReplySendReceiver` — capture original suggestion + user edit on send | S |
| 0.5 | Replace deprecated `isAppInForeground()` — AppState-backed SharedPreferences flag | S |
| 0.6 | Add `isPackageInForeground(sbn.packageName)` — accumulate always, suppress notification when source app is open | M |
| 0.7 | `onNotificationRemoved` REASON_APP_CANCEL handler — write last-opened conversation per package to SharedPreferences | M |

---

## Sprint 1 — Onboarding & Context Building
**Goal:** Give the model enough context about the user to make suggestions that feel personal from day one.
**Can start now** (JS/TS work, no build needed).

| # | Deliverable | Size |
|---|---|---|
| 1.1 | Add `contacts.readonly` + `contacts.other.readonly` to Google OAuth scopes | S |
| 1.2 | Call Google People API after sign-in → populate SQLite `contacts` + `platform_identities` | M |
| 1.3 | `expo-contacts` import on permission grant — merge device contacts, deduplicate by phone/email | M |
| 1.4 | WhatsApp `.txt` export parser — accept share, parse sender/timestamp/text, seed `NotificationStore` + `memories` | L |
| 1.5 | Onboarding flow — sign in → set home/work → grant notification access → grant accessibility → import contacts | L |

_TDLib (Telegram real-time sync): deferred — revisit after Play Store launch._

---

## Sprint 2 — Keyboard Extension + AccessibilityService
**Goal:** When the user is actively inside a messaging app, show a suggestion strip above the keyboard. AccessibilityService bundled here for a single Play Store feature declaration.
**Depends on:** Sprint 0 stable.

| # | Deliverable | Size |
|---|---|---|
| 2.1 | Android `InputMethodService` shell — registers as system IME | M |
| 2.2 | Suggestion strip UI — single row with suggestion text, "Use", "Edit", "Dismiss" | M |
| 2.3 | `NotificationStore.getMostRecentThread(packageName)` — context feed for IME | S |
| 2.4 | Wire `onNotificationRemoved` last-opened conversation (Sprint 0.7) into IME | M |
| 2.5 | Cancel suggestion notification when IME activates in the same target app | S |
| 2.6 | Capture IME edit signal → `style_edits` table | S |
| 2.7 | `AccessibilityService` — reads on-screen messages while user is in active conversation, feeds `NotificationStore` | M |
| 2.8 | Deduplication — don't double-append messages that also arrived via NLS | S |
| 2.9 | Accessibility permission onboarding screen — what it reads, why, how to disable | M |
| 2.10 | Play Store Accessibility declaration text | S |

_iOS keyboard extension (`UIInputViewController`): deferred — Android must be validated first._

---

## Sprint 3 — Style Learning & Personalisation
**Goal:** Use the edit history accumulated in `style_edits` to progressively personalise suggestions.
**Depends on:** Sprint 0.4 (style_edits must be populating).

| # | Deliverable | Size |
|---|---|---|
| 3.1 | Style profile builder — aggregate `style_edits` per contact into tone/length/vocabulary signals | M |
| 3.2 | Include style profile in Worker prompt alongside conversation thread | S |
| 3.3 | Per-contact override — relationship + tone preference editable in contact detail view | M |
| 3.4 | Worker 3-tone output — formal / casual / brief surfaced in notification + IME strip | S |
| 3.5 | Dismiss signal — record ACTION_DISMISS in `style_edits` as negative weight | S |

---

## Sprint 4 — Cloud Sync
**Goal:** Optional opt-in backup so users don't lose context on a new device.
**Cloud sync is OFF by default.**
**Depends on:** Sprint 0 + Sprint 1 (local data worth syncing).

| # | Deliverable | Size |
|---|---|---|
| 4.1 | Cloudflare D1 schema — mirror of `saved_places`, `contacts`, `style_edits`, `memories` | S |
| 4.2 | Worker `/sync` endpoint — authenticated POST, upserts rows, returns timestamps | M |
| 4.3 | JS sync service — `getPendingSyncItems()` → Worker → `markSynced()` | M |
| 4.4 | Restore on new device — pull D1 rows on sign-in | M |
| 4.5 | Settings toggle — "Enable cloud backup" off by default, clear explanation of what's synced | S |

---

## Sprint 5 — App Polish & Settings Hub
**Goal:** Make the app feel complete and user-configurable.

| # | Deliverable | Size |
|---|---|---|
| 5.1 | Settings screen — group message toggle, platform toggles, notification permission deep link | M |
| 5.2 | Places screen — add/edit home + work via Maps autocomplete | M |
| 5.3 | Contacts screen — list, edit relationship/notes, linked platform identities | M |
| 5.4 | Message bubble UI — cleaner chat thread display | S |

---

## Sprint 6 — Play Store Launch
**Goal:** Internal track first (unblocks ColorOS NLS issue), then open beta.
**Depends on:** Sprint 0 + Sprint 2 (Accessibility declaration) + Sprint 5 (onboarding).

| # | Deliverable | Size |
|---|---|---|
| 6.1 | Final app name confirmed | S |
| 6.2 | Privacy policy — NLS, AccessibilityService, Google data, Worker API | M |
| 6.3 | Play Store listing — screenshots, description, Accessibility declaration | M |
| 6.4 | Google Play Console setup + internal testing track publish | S |
| 6.5 | Closed testing (10+ testers) | M |

---

## Recommended Order

```
Now (write code, can't build yet):
  Sprint 0 code → Sprint 1 → Sprint 2 (start)

July 1 (EAS resets):
  Sprint 0 build + device test → continue Sprint 2

After Sprint 2 validated:
  Sprint 3 → Sprint 4 → Sprint 5 → Sprint 6
```
