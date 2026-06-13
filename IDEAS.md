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

## Product Improvements (beyond dual-user mode)

### Context Sources
- **Weather** — *"It's raining, might be a few mins late"* auto-added to ETA replies
- **Battery level** — *"Phone's dying, will call when I'm there"*
- **Driving mode** — auto-detect motion → auto-reply *"driving, back in 20"*
- **Apple Health / activity** — detect if working out, sleeping, in focus mode
- **Conversation history** — read last 10 messages for richer context, not just the latest message
- **Email** — extend beyond SMS/messaging to Gmail, Outlook

### Reply Intelligence
- **Style cloning** — analyse past texts to match the user's actual writing voice (punctuation, emoji frequency, sentence length). Replies sound like *them*, not AI.
- **Sentiment detection** — if incoming message is upset or urgent, tone adapts automatically
- **Per-contact tone memory** — always reply casually to Tom, formally to the manager
- **Feedback loop** — track which suggestions are used vs regenerated, improve over time
- **Group chat mode** — message from multiple people, reply that addresses all of them

### Platform Expansion
- **Mac menu bar app** — highlight any text anywhere → get a reply suggestion (biggest desktop unlock)
- **Email plugin** — Gmail / Outlook plugin for suggested email replies
- **Slack / Teams** — reply suggestions in work chat
- **Instagram / LinkedIn DMs** — via Share Extension
- **Screenshot OCR** — take a screenshot of any message, app reads it and suggests a reply (eliminates copy-paste entirely — biggest UX jump)

### UX Shortcuts
- **Voice input** — speak the incoming message instead of typing it
- **Lock screen widget** (iOS 16+) — see and copy the latest suggestion without unlocking
- **Dynamic Island** — show reply status while processing
- **Home screen widget** — paste a message, get a reply on the home screen
- **Apple Watch** — tap to copy top suggestion to clipboard

### Personalisation
- **Custom tones** — beyond Brief/Casual/Professional, let users define their own (e.g. "warm but concise")
- **Language matching** — detect incoming message language, reply in the same one
- **Emoji matching** — mirror the sender's emoji usage style
- **Boundary mode** — *"After 9pm, suggest polite defer replies only"*

### Wellbeing / Safety
- **Toxic message detection** — flag aggressive or manipulative messages, suggest whether to reply at all
- **Reply check** — warn if the suggested reply might read badly (*"this might come across as passive-aggressive"*)
- **Focus mode integration** — when iPhone Focus is on, only suggest short deferral replies

### Business / Team
- **Team style guides** — company sets a tone guide, all employee replies follow it
- **Out-of-office handling** — auto-generate OOO replies with real context
- **Enterprise API** — developers embed ProTxt's context engine into their own products

### Priority ranking (by impact)
1. Screenshot OCR — eliminates copy-paste, biggest UX jump
2. Style cloning — makes replies feel personal not AI-generated
3. Mac menu bar — expands to desktop where a lot of messaging happens
4. Conversation history context — dramatically improves reply quality
5. Driving auto-mode — fully passive, zero friction

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

### Real apps that already do this
- **Apple FindMy** — encrypted location beacons, Apple can't read them
- **COVID Exposure Apps** (Apple/Google GAEN) — anonymous token matching happens locally
- **Signal** — private contact discovery without uploading address book
- **iMessage** — checks if contacts have iMessage without Apple learning your contact list

### Practical options (simplest → most private)

**Option 1 — Grid Cells (MVP, easiest)**
Divide world into 1km² squares. Share cell ID, not coordinates. App checks if cells are adjacent.
- Easy to implement, no cryptography library needed
- "We share your neighbourhood, not your address"

**Option 2 — Trusted Execution Environment**
Both coordinates sent to a server running inside a hardware enclave (Intel SGX / Apple Secure Enclave). Even server operator can't read inputs. Returns only the result.
- More practical than full MPC, similar guarantees

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

