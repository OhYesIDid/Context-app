# Contxt — Bug Tracker

## Open

_No open bugs._

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
