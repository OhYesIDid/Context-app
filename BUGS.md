# Contxt — Bug Tracker

## Open

### [BUG-003] "Leave" feature — extend the calendar/departure prompt to non-calendar events (unfinished, resume on laptop)
**Area:** Worker prompt (`calendar_add` action) / departure-time or "when to leave" logic
**Status:** In progress on a laptop CLI session as of 2026-08-06; not committed or pushed anywhere, so none of that work exists in this repo yet. Confirmed via full branch sweep (all 11 remote branches, latest commit dated 2026-07-30) that nothing newer has landed.
**What it needs:** The laptop session was extending a "leave"/departure-time prompt so it also covers non-calendar events — i.e. plans detected from a message or booking (via the worker's `calendar_add` action, `worker/src/index.ts` `SYSTEM_PROMPT` around line 618) or from Gmail bookings (`src/services/upcomingEvents.ts`), not just entries that already exist as real Google Calendar events. Exact scope/design wasn't captured before the laptop went out of reach — confirm with Tommy before continuing, don't assume.
**Next step:** On the laptop, `git add` / `git commit` / `git push` whatever's in the working tree (even to a scratch branch) so this can be picked up from any session instead of being laptop-local.

### [BUG-004] "Leave" nudge for a flight doesn't account for required early-arrival buffer
**Area:** Same "leave"/departure-nudge feature as BUG-003. Reported by Tommy 2026-08-06 from the live Play Store build (versionCode ~149) — this feature is confirmed shipped in production even though its source isn't in this repo yet (see BUG-003), so the fix has to land wherever that code actually lives (laptop working tree), not be guessed at from here.
**Symptom:** The nudge to leave for a flight was calculated using only travel time to the airport (e.g. Maps ETA) — it did not add any buffer for check-in/security, so it prompted the user to leave later than they actually needed to.
**Expected:** The leave-time calculation needs a buffer added on top of raw travel time, and that buffer should vary by event type — e.g. a flight needs ~2 hours (international may need more), a train/bus needs a few minutes for the platform, a restaurant/meeting needs little to none. Buffer should not be a flat constant across all event/booking types.
**Fix:** Not yet fixed — logged for the laptop CLI session to pick up alongside BUG-003, since it's the same feature and the same missing source.

---

## Resolved

### [BUG-001] ETA intent doesn't use recent message history for location context
**Area:** ETA intent detection / Claude prompt
**Symptom:** When an incoming message triggers the ETA flow, the reply is generated without checking the last X messages in the conversation for location context (e.g. a previous message saying "I'm leaving from the office on Main St" is ignored).
**Fix:** `buildEnrichments` now accepts the full thread and passes it to `fetchEtaData`. The destination extractor searches the latest message first, then walks the thread in reverse so destinations mentioned in earlier messages are picked up even when the triggering message is just "are you close?". Committed on `sprint/2-ime`.

### [BUG-002] App does not sync conversation state with active notifications / outbound messages
**Area:** Notification listener / conversation context
**Symptom (inbound):** When the user sends messages directly inside a messaging app while Contxt is running, those outbound messages are not captured.
**Symptom (outbound):** Sent replies were never written back to the conversation history.
**Actioned:** Outbound MessagingStyle detection (Gate 6) suppresses stale suggestions after the user replies natively. `captureInputFieldText` via AccessibilityService captures the sent text and writes it to ContactMemory. `markReplied` clears the NotificationStore thread on send so the next suggestion starts from a clean slate. Mid-thread outbound detection reseeds the store from post-reply messages when WhatsApp bundles the full updated thread on the next inbound notification.
