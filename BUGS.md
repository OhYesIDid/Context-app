# Contxt — Bug Tracker

## Open

### [BUG-003] "Leave" feature — extend the calendar/departure prompt to non-calendar events (unfinished, resume on laptop)
**Area:** Worker prompt (`calendar_add` action) / departure-time or "when to leave" logic
**Status:** In progress on a laptop CLI session as of 2026-08-06; not committed or pushed anywhere, so none of that work exists in this repo yet. Confirmed via full branch sweep (all 11 remote branches, latest commit dated 2026-07-30) that nothing newer has landed.
**What it needs:** The laptop session was extending a "leave"/departure-time prompt so it also covers non-calendar events — i.e. plans detected from a message or booking (via the worker's `calendar_add` action, `worker/src/index.ts` `SYSTEM_PROMPT` around line 618) or from Gmail bookings (`src/services/upcomingEvents.ts`), not just entries that already exist as real Google Calendar events. Exact scope/design wasn't captured before the laptop went out of reach — confirm with Tommy before continuing, don't assume.
**Next step:** On the laptop, `git add` / `git commit` / `git push` whatever's in the working tree (even to a scratch branch) so this can be picked up from any session instead of being laptop-local.

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
