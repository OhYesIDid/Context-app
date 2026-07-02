# Ideas & Questions

A running list of ideas, open questions, and things to explore.
Add anything here — the CLI will reference this file alongside CLAUDE.md.

---

## Open Questions

- ~~Should the domain be `.app` or `.io`?~~ **get-context.app** ✓
- ~~Free tier vs paid from day one?~~ **Freemium** — core suggestions free, Pro tier gates tone learning, strategy pills, default tone, suggest-all-messages ✓
- ~~Should the Cloudflare Worker proxy require auth (API key per user) or be open?~~ **HMAC signing sufficient for launch** — blocks external callers; per-user server-side entitlement check deferred to post-launch if abuse becomes an issue ✓

---

## Known Issues

- **Same-name contact collision in conversation key** — `buildConversationKey()` (`ProTxtBgService.kt`) keys conversations by notification title (the display name shown by the messaging app). Two different contacts with the same name (e.g. two "John"s) will collide on the same `convKey`, causing their message buffers, bubble, and thread history to be shared. Rare but real. Tried fixing 2026-06-16 by keying on `sbn.id` instead, but that broke far worse — `sbn.id` was found to be reused across unrelated active conversations on the test device, causing frequent cross-conversation contamination. Reverted; title-based key stays until a verified-reliable per-conversation ID is found.
- **`sbn.id` fallback collision (narrower version of the above)** — in the same function, if a notification has no `conversationTitle` and no `title` (or a group with no `conversationTitle`), the key falls back to `"id:${sbn.id}"` / `"group:${sbn.id}"`. Same collision risk as above, just rarer since most WhatsApp/Telegram notifications carry a title. Pre-existing, not introduced by the 2026-06-16 revert.
- **No certificate pinning on outbound API calls** — `src/services/claude.ts`, `googleMaps.ts`, `googleCalendar.ts` all use plain `fetch` with no pinning. A MITM with a trusted root CA on the device could intercept traffic. (Critical, ~4h fix — see security audit)
- ~~**SQLite database unencrypted**~~ — All sensitive text fields encrypted with AES-256-GCM (Keystore-backed). lat/lng stored in encrypted TEXT columns. Identifiers HMAC-SHA256 hashed for lookup. DB excluded from Android backup via `backup_rules.xml` / `data_extraction_rules.xml`. ✓

---

## Design

- Logo direction: **Thread Bars** and **Reply Arc** are the most distinctive — explore further
- App icon should work at 60x60px — test all concepts at small size
- Consider a light mode variant of the UI

---

## Shipped

Features already live in the codebase — kept here for context.

- **Style learning** — suggestion → what was actually sent recorded; recency decay (14-day half-life); per-intent and per-contact grouping; native sync without app-open
- **Per-contact tone & relationship** — contacts table with preferred tone and relationship tag; pre-selects bubble tab
- **Conversation history context** — notification thread tracked in `ProTxtBgService`; last N messages sent as context to worker
- **Intent detection** — ETA, availability, booking, general; drives which enrichments are fetched
- **ETA enrichment** — Google Maps live ETA injected into reply
- **Calendar enrichment** — Google Calendar free/busy checked for availability replies
- **Gmail bookings** — reservation lookup for travel/restaurant questions
- **Show all buffered messages in the bubble** — `arrivalBuffer` collects every message that arrives during the debounce window; on fire, all buffered texts are deduped and joined with `\n` into both the worker context and the bubble's quote section (`ProTxtBgService.kt:357,407-411`). Capped at 3 visible lines before truncating.
- **Error state + retry on failed reply generation** — a failed/timed-out worker call now shows a "Couldn't generate a reply" bubble with Retry/Dismiss actions instead of silently disappearing. Retry re-runs the same worker call via the cached `PendingBubble` (`ACTION_RETRY`, `ProTxtBgService.kt` `postErrorNotification`/`retry`/`runWorkerJob`).
- **Regenerate on the bubble** — circular arrow button in `BubbleSuggestionActivity` lets the user re-run the worker call on any suggestion, not just failed ones.
- **Live-apply group message toggle** — toggling skip_group_messages on immediately calls `dismissAllGroupBubbles()` on the service, cancelling all active/pending group bubbles. Group convKeys tracked in `groupConvKeys` set since groups often use the group name (not a "group:" prefix) as the convKey.
- **Message importance assessment + Pending Replies** — `MessageImportance.kt` scores each incoming burst (urgent/elevated/normal) from the existing per-message emotion signal (`detectEmotionalCharge`) plus arrival cadence (rapid repeats) and unanswered-backlog gap (`NotificationStore.getFirstUnreadTimestamp`). Every non-group incoming message upserts an entry in the `pending_replies` SharedPrefs list (`ProTxtBgService.upsertPendingReply`/`clearPendingReply`, cleared on every existing `markReplied` site), exposed to JS via `ProTxtSettingsModule.getPendingReplies`/`clearPendingReply`/`openConversationApp` and rendered as the "Pending Replies" card on `HomeScreen`, sorted by importance. The score also rides along to the worker (`WorkerClient.call` → `SuggestRequest.importance`/`importanceReasons` in `worker/src/index.ts`) as extra prompt context biasing toward a shorter, more direct reply — separate from the per-message `emotion` enrichment, which it complements rather than replaces.

---

## Planned

High confidence, clear implementation path.

### Notification-shade suggestion
Show the reply text inside the notification itself — not just the bubble. User reads and copies directly from the shade without tapping anything. Zero-friction path for people who don't want bubbles. Use `BigTextStyle` or a custom notification layout.

### Adaptive debounce window
`DEBOUNCE_MS` (`ProTxtBgService.kt`) is a fixed 2.5s wait for every message before the worker call fires — collapses rapid-fire bursts into one API call/suggestion instead of one per message, but the fixed window is a guess: too short to catch slower double-texters, too long for someone who only ever sends one message at a time. Possible signals to make it adaptive instead, cheapest first:
- **Trailing punctuation/completeness of the latest buffered message** — ends in `.`/`?`/`!` reads as finished (fire sooner); ends mid-sentence or on a single word ("wait", "so") reads as a continuation (extend the wait). No new tracking needed, just a heuristic on text already in hand.
- **App-side batching signal** — if a single `onNotificationPosted` update's `EXTRA_MESSAGES` count jumps by more than one at once, the messaging app already coalesced a burst for us; less reason to keep waiting.
- **Per-contact learned double-texting rate** — track a rolling average inter-message gap per contact (similar to existing style-learning profiles) and size that contact's window to their own texting pattern. More powerful, more complexity, and a cold-start period with no data per contact.

Recommended starting point: the punctuation heuristic — simplest, no new storage, covers the common "finished sentence vs. trailing off" case.

### Urgency detection — remaining pieces
Message-importance scoring shipped (see Shipped section) covering signal detection + worker prompt bias + the Pending Replies surface. Not yet done: a visual urgency indicator on the bubble itself (would need threading `MessageImportance.Result` through `postLoadingNotification`/`postSuggestionNotification`, which today only take the raw intent string), shortening the debounce window for urgent bursts, a higher-priority notification when the device is locked, and feeding into proactive follow-up (lower the reminder threshold for contacts who tend to send urgent messages).

### Per-contact data insights
Stats surfaced in the contact detail / settings view: average reply time (time between incoming message timestamp and user's outbound reply stamped in `ContactMemory`/`StyleEditQueue`), messages per month (count from `NotificationStore`/`StyleEditQueue` grouped by contact + month), most active hour, most common intent types. Could also flag contacts whose reply time is trending up ("you're taking longer to reply to Sarah"). Data is already partially captured — `StyleEditQueue` records suggestion→send pairs with timestamps, and `arrivalBuffer` sees every incoming message. Main new work: aggregate queries + a UI surface.

### Quick-reply templates
One-tap canned replies for universal scenarios — running late, driving, in a meeting, can't talk. Bypass AI entirely. Useful as a fallback when the service is slow or offline, and faster than waiting for a suggestion.

### Proactive follow-up
If a message arrived and the user hasn't replied in X hours, surface a reminder notification with a pre-generated reply ready to send. Opt-in per contact. High value for people who read and forget.

### Calendar event — include contact as attendee
When the user taps the "Add to Calendar" action button, pre-populate the sender as an attendee and add them to the event description. Implementation: pass `EXTRA_PERSON_NAME` / `EXTRA_PERSON_EMAIL` from `BubbleSuggestionActivity.postActionFollowUp` (resolved from `contactMatchJson` or `DeviceContactsResolver`); in `ActionReceiver.ACTION_CALENDAR_ADD`, set `CalendarContract.Attendees.ATTENDEE_EMAIL` on the INSERT intent if an email is available, otherwise append "with [Name]" to `CalendarContract.Events.DESCRIPTION`. No new permissions needed — the insert intent already opens the calendar app for confirmation.

### Screenshot OCR
Take a screenshot of any message → app reads it and suggests a reply. Eliminates copy-paste entirely for apps not covered by the notification listener. Biggest UX jump for platform coverage.

---

## Someday

Worth building eventually; needs more thought or platform maturity.

### Suppress original app notification
When our bubble appears, optionally cancel the original WhatsApp/Messenger notification from the shade via `cancelNotification(sbn.key)` in the NLS. Keeps the shade clean — only our bubble shows. Needs a user-facing toggle since it means the original notification won't reappear if the bubble is dismissed without acting. "Mark as read" already handles the explicit read path.

### ~~Android Auto~~ ✓
~~Already on Android, already have ETA context. Suggest and send replies through the car dashboard. Natural fit with driving mode and ETA suggestions.~~
Shipped: `MessagingStyle` notification + `RemoteInput.setChoices()` with all tone variants. Auto shows the incoming message as a conversation card; user taps a choice to send directly. `automotive_app_desc.xml` declares notification support.

### IME keyboard extension
A proper Android Input Method (keyboard replacement) that shows suggestions inline in the keyboard suggestion bar. More reliable than an accessibility overlay — works in every app without the overlay permission complexity. Significant engineering effort but eliminates the biggest setup friction.

### Mac menu bar app
Highlight any text anywhere → get a reply suggestion. Biggest desktop unlock. Covers iMessage on Mac, WhatsApp Web, any browser-based messaging.

### Driving auto-mode
Detect motion via accelerometer / Android Auto → automatically switch to short deferral replies. Fully passive, zero friction.

### Boundary mode
After 9pm (or custom hours), suggest polite defer replies only. Pairs with Focus mode integration.

### Wellbeing
- **Toxic message detection** — flag aggressive or manipulative messages, suggest whether to reply at all
- **Reply check** — warn if the suggested reply might read as passive-aggressive
- **Focus mode integration** — when Focus is on, only suggest short deferral replies

### Platform expansion
- Email plugin — Gmail / Outlook plugin for suggested email replies
- Slack / Teams — reply suggestions in work chat
- Instagram / LinkedIn DMs — via Share Extension
- Web app for desktop texting

### UX shortcuts
- Voice input — speak the incoming message instead of typing it
- Lock screen widget (iOS 16+) — see and copy latest suggestion without unlocking
- Dynamic Island — show reply status while processing
- Home screen widget — paste a message, get a reply on the home screen
- Apple Watch — tap to copy top suggestion to clipboard
- Landscape orientation — make the bubble activity scrollable so long threads/replies aren't clipped when the device is rotated

- ~~Landscape orientation~~ ✓ — bubble wrapped in `ScrollView`; the quote section already scrolls within its fixed height; entire UI now scrollable when rotated.
- ~~Quoted message capped at 3 lines~~ ✓ — quote section is a `ScrollView` with fading edges; height auto-fits to content up to `68dp` then scrolls.

### Personalisation
- **Custom tones** — beyond Brief/Casual/Professional, let users define their own (e.g. "warm but concise")
- **Language matching + translation** — detect incoming message language, reply in the same one; optionally translate the incoming message into the user's language before showing the suggestion
- **Emoji matching** — mirror the sender's emoji usage style

### Business / Team
- **Team style guides** — company sets a tone guide, all employee replies follow it
- **Out-of-office handling** — auto-generate OOO replies with real context
- **Enterprise API** — developers embed ProTxt's context engine into their own products

---

## Dual-User Mode

When both users have the app installed, context becomes bidirectional — a major product differentiator.

**What's unlocked:**
- ETA uses User A's *actual* location as the destination (not a guessed one)
- Availability checks *both* calendars and suggests mutual free slots
- Live status: User A sees "User B is driving" without asking
- Proximity detection: suggest meeting instead of texting when both are nearby
- Smart scheduling: "When are you free?" cross-references both calendars

**Privacy model — per-contact permissions:**
First time a contact requests your context, a prompt appears:
```
[ Always Allow ]  [ Allow Once ]  [ Don't Allow ]
```
This is per-contact AND per-data-type (location / calendar / status).
Examples:
- Partner: location always, calendar always
- Friend: location once, calendar free/busy only
- Colleague: location never, calendar free/busy only
- "Always" auto-expires after 30 days and re-prompts

**Privacy architecture:**
- Ephemeral only — data used once per reply, never stored
- Fuzzy data — share "12 min away" not GPS coordinates; "busy until 3pm" not event names
- Peer-to-peer relay — server is an encrypted relay only, never reads data
- Access log — users can see who checked their context and when
- One-tap revoke from notification shade

**Open questions:**
- How do we detect if both users have the app? (Hash phone numbers on-device, like Signal)
- Should "Always" permissions have a time limit?
- Should there be a "trusted contacts" group that gets broader access by default?

**Marketing angle:**
*"You decide who sees what. Your partner gets your live ETA. Your boss never sees your location."*

---

## Zero-Knowledge Location (advanced privacy)

True ZKP lets two users compute their distance **without either revealing their exact coordinates** to each other or to any server.

### How it works (Secure Multiparty Computation)
Both devices compute a result over private inputs without seeing each other's input:
```
User A's device                                     User B's device
GPS: [secret]                                       GPS: [secret]
      │                                                   │
      └── encrypted fragment → relay ← encrypted fragment ┘
                                 │
                        computes distance on encrypted data
                                 │
                       result: "0.9 miles" → both devices
```
Server sees only encrypted blobs. Computation is split across both devices using a garbled circuit protocol.

### Practical options (simplest → most private)

**Option 1 — Grid Cells (MVP, easiest)**
Divide world into 1km² squares. Share cell ID, not coordinates. App checks if cells are adjacent.
- Easy to implement, no cryptography library needed
- "We share your neighbourhood, not your address"

**Option 2 — Trusted Execution Environment**
Both coordinates sent to a server running inside a hardware enclave (Intel SGX / Apple Secure Enclave). Even server operator can't read inputs. Returns only the result.

**Option 3 — Commit-then-Reveal**
1. Both users commit to their location (send a hash, not location)
2. Exchange commitments
3. Simultaneously reveal locations
4. Each device computes distance locally
5. Hash proves neither changed their location after seeing the other's

**Option 4 — Full MPC (v2+)**
Libraries: [SEAL](https://github.com/microsoft/SEAL) (Microsoft), [MP-SPDZ](https://github.com/data61/MP-SPDZ). Maturing fast. Worth revisiting as mobile performance improves.

### Recommendation
Use **Grid Cells** for MVP (fast, private, explainable), upgrade to **TEE** for v2.

### User-facing claim
*"ProTxt calculates distance without either user's exact location ever leaving their device."*

---

## Notes

_(add freeform notes here)_
