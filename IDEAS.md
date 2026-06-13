# Ideas & Questions

A running list of ideas, open questions, and things to explore.
Add anything here — the CLI will reference this file alongside CLAUDE.md.

---

## Open Questions

- What should the app be called? Leading candidates: **Protxt**, **Veritxt**, **Witxt**, **Copy That**
- Should the domain be `.app` or `.io`?
- Free tier vs paid from day one?
- Should the Cloudflare Worker proxy require auth (API key per user) or be open?

---

## Ideas to Explore

- Tone memory: remember a user's preferred tone per contact (e.g. always "casual" with Mom)
- Reply history: swipe back through past AI replies for a conversation
- Siri Shortcut integration: "Hey Siri, suggest a reply"
- iMessage app extension (appears in the app strip inside iMessage)
- Apple Watch complication: tap to copy latest suggested reply
- Android Wear OS companion
- Web app version for desktop texting (iMessage on Mac, WhatsApp Web)

---

## Design Ideas

- Logo direction: **Thread Bars** and **Reply Arc** are the most distinctive — explore further
- App icon should work at 60x60px — test all concepts at small size
- Consider a light mode variant of the UI

---

## Dual-User Mode (both parties have the app)

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

## Notes

_(add freeform notes here)_

