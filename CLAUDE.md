# Context App — Project Brief

> See also: `IDEAS.md` — running list of ideas, open questions, and design notes.

## What this app does
A mobile app (React Native + Expo) that suggests context-aware AI replies to incoming messages. It detects message intent (ETA, availability, general) and uses the Claude API + Google Calendar + Google Maps to generate smart replies.

## Current state

### What's been built (Sprint 1 PoC — complete)
- Expo SDK 52, managed workflow (no prebuild yet), React Native 0.76.5, New Architecture enabled
- Stack: TypeScript + Claude API (`claude-sonnet-4-20250514`) + Google Calendar API + Google Maps API + `expo-clipboard`
- **Single screen** (`App.tsx`): user pastes a message → detects intent → fetches real context → Claude drafts a reply → user copies it

### Code structure
```
App.tsx                          — single screen UI (dark theme, indigo accent #6366f1)
src/
  services/
    claude.ts                    — Claude API call (15s timeout, abort controller, prompt injection protection via XML delimiters)
    googleCalendar.ts            — Google Calendar free/busy fetch
    googleMaps.ts                — Google Maps distance/ETA fetch
  types/index.ts                 — Intent, EtaData, AvailabilityData, SuggestReplyInput
  utils/intentDetector.ts        — keyword-based intent classifier (eta | availability | other)
assets/                          — logo concepts (SVG): thread-bars, reply-arc, glass, wordmark
```

### Key implementation decisions already in code
- API key via `EXPO_PUBLIC_CLAUDE_API_KEY` env var (see `.env.example`)
- Prompt injection guard: user message wrapped in `<message>` XML tags so Claude ignores any instructions inside it
- 15 000 ms request timeout with `AbortController`
- App title in UI is "ContextReply" (name not finalised — see candidates below)
- No native extensions yet — next step is `npx expo prebuild` to unlock Android/iOS phases

### What's next (in priority order)
1. `npx expo prebuild` — generates `/android` and `/ios` native folders (required for overlay bubble)
2. Android NotificationListenerService
3. Android floating overlay bubble
4. iOS notification reply action
5. iOS Share Extension
6. Cloudflare Worker proxy (move API key off device)
7. Core app refactor (settings hub, 3-tone replies, history)

## App name
**ConTxt** — confirmed. Domain: www.get-contxt.app

---

## Build Plan: Native Extensions (7 days total)

The goal is to eliminate app-switching friction. Instead of copy → switch app → paste → get reply → copy → switch back, replies surface where the user already is.

### Optimal target experience
- **Android:** Notification listener auto-detects incoming messages → floating bubble appears → tap for 2-3 reply options → send directly
- **iOS:** Share Extension (long-press message → Share → app) + Notification reply action button on lockscreen

---

### One-time setup (Day 1, ~0.5 days)

```bash
npx expo prebuild
```

Generates `/android` and `/ios` native folders (Expo CNG — not a permanent eject). Required for the Android overlay. Do this first.

Also set up EAS Build:
```bash
npm install -g eas-cli
eas login
eas build:configure
```

---

### Phase 1 — Android (Days 1–3)

#### Step 1: NotificationListenerService
**Package:** `expo-android-notification-listener-service`

Reads incoming notifications from WhatsApp, iMessage, Messenger, etc. Works in CNG workflow — no manual native code needed.

```bash
npm install expo-android-notification-listener-service
```

Add to `app.json` plugins, filter target packages, subscribe to `"onNotificationReceived"` events, pass notification text to Claude API.

User grants access once via: **Settings → Notification Access → app**

#### Step 2: Floating Overlay Bubble
**Package:** `@fabithub/react-native-floating-bubble`

Draws a persistent floating bubble over all apps. Requires bare/CNG workflow (already done).

```bash
npm install @fabithub/react-native-floating-bubble
```

Wire up: `MainApplication.kt` → register package, `AndroidManifest.xml` → `SYSTEM_ALERT_WINDOW` + foreground service.

Bubble tap → mini bottom sheet:
```
┌─────────────────────────────┐
│ 💬 "Hey when are you here?" │
│─────────────────────────────│
│ Brief    Casual    Formal   │
│─────────────────────────────│
│ "About 12 min, on my way!"  │
│  [  ↗ Send  ]  [ ↻ Again ] │
└─────────────────────────────┘
```

Play Store risk: Low-medium. Declare `SYSTEM_ALERT_WINDOW` in Data Safety section.

**Skip for now:** AccessibilityService (auto-insert text into other apps) — requires Google approval, high removal risk.

---

### Phase 2 — iOS (Days 4–6)

#### Step 1: Notification Reply Action
**Package:** `expo-notifications` (built into Expo, no extra install)

Adds "Suggest Reply" button directly on iOS notification banner. Works in managed/CNG workflow.

```typescript
await Notifications.setNotificationCategoryAsync('incoming_message', [
  {
    identifier: 'SUGGEST_REPLY',
    buttonTitle: 'Suggest Reply',
    textInput: { submitButtonTitle: 'Send', placeholder: 'Reply…' },
  }
])
```

#### Step 2: Share Extension
**Package:** `expo-share-extension`

```bash
npm install expo-share-extension
```

User long-presses any message → Share → app in sheet → reply appears without leaving the messaging app.

Configure in `app.json`:
- `NSExtensionActivationRules`: plainText
- Shared App Group container (to pass data between extension and main app)

30MB RAM limit in extensions: extension UI is a thin native shell, Claude call goes through lightweight fetch, result stored in App Group.

Requires: Apple Developer account ($99/yr) + EAS Build for cloud signing.

---

### Phase 3 — Backend proxy (Day 6, ~0.5 days)

The Claude API key must be reachable from extensions without living on-device.

**Use a Cloudflare Worker proxy** (free tier, ~10 lines):
```
Extension/App → POST https://your-worker.workers.dev/suggest → Claude API
```

Keeps the API key off the device entirely.

---

### Phase 4 — Core app refactor (Day 7, ~1.5 days)

The main app becomes a settings + permissions hub:
- Onboarding: grant Notification Access (Android) / notification permissions (iOS)
- Select which apps to monitor (WhatsApp, iMessage, Telegram, etc.)
- Default tone preference (Brief / Casual / Professional)
- Reply history
- API/account settings

Also refactor the reply UI:
- Generate 2–3 tonal variations per message
- Style as message bubbles (original quoted, reply in indigo bubble)
- Share sheet button to send directly
- Regenerate button

---

### Build order summary

| # | Task | Platform | Days |
|---|---|---|---|
| 1 | `npx expo prebuild` + EAS setup | Both | 0.5 |
| 2 | NotificationListenerService | Android | 1 |
| 3 | Floating overlay bubble | Android | 1.5 |
| 4 | Notification reply action | iOS | 0.5 |
| 5 | Share Extension | iOS | 1.5 |
| 6 | Cloudflare Worker proxy | Both | 0.5 |
| 7 | Core app refactor | Both | 1.5 |
| | **Total** | | **~7 days** |

---

## Key decisions already made
- Skip AccessibilityService (Play Store policy risk too high)
- Use Cloudflare Worker proxy for API key security (not shared keychain)
- Expo CNG (`prebuild`) not full eject — native folders are generated, config plugins still work
- Android first (more powerful, lower friction to build)

## Resources
- [expo-android-notification-listener-service](https://github.com/SeokyoungYou/expo-android-notification-listener-service)
- [expo-share-extension](https://github.com/MaxAst/expo-share-extension)
- [@fabithub/react-native-floating-bubble](https://www.npmjs.com/package/@fabithub/react-native-floating-bubble)
- [EAS Build docs](https://docs.expo.dev/build/introduction/)
- [Expo CNG docs](https://docs.expo.dev/workflow/continuous-native-generation/)
