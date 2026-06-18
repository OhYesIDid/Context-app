# Contxt — Bug Tracker

## Open

### [BUG-001] ETA intent doesn't use recent message history for location context
**Area:** ETA intent detection / Claude prompt  
**Symptom:** When an incoming message triggers the ETA flow, the reply is generated without checking the last X messages in the conversation for location context (e.g. a previous message saying "I'm leaving from the office on Main St" is ignored).  
**Expected:** The last N messages should be retrieved and included in the Claude prompt so location/context clues from earlier in the thread inform the ETA reply.  
**Possible fix:** Extend the context window passed to the Claude API call for ETA intents — pull the last 5–10 messages from the thread and prepend them to the system/user prompt.
