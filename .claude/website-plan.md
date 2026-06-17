# Website Plan
_Created: 2026-06-17_

## Goal
A single-page marketing site to collect waitlist signups before Play Store launch.
No app store yet → waitlist is the only conversion action.

---

## Audience
- Android users (primary — app launches Android first)
- People who text a lot and feel friction switching apps to look up ETAs, availability, etc.
- Early adopter / tech-curious demographic

---

## Domain
Leading candidate: `witxt.app` — short, brandable, memorable
Fallback: `contextual.app` (domain for sale, more descriptive)
Decide name before building → name goes everywhere on the site.

---

## Pages
Single page (no multi-page navigation needed pre-launch):

```
/          Hero + how it works + features + waitlist
/privacy   Privacy policy (required for Play Store)
```

---

## Page Structure

### 1. Hero
- **Headline:** "Reply instantly. Without switching apps."
- **Subhead:** "ContextReply reads your ETA, checks your calendar, and drafts the right reply — delivered as a floating bubble over any messaging app."
- **CTA:** Email input + "Join the waitlist" button
- **Visual:** Phone mockup showing the bubble bottom sheet (Brief / Casual / Formal tabs + suggested reply)

### 2. How it works (3 steps)
1. A message arrives — ContextReply reads it silently in the background
2. It checks your real context (Maps ETA, Calendar, Gmail bookings)
3. A reply suggestion appears as a floating bubble — tap to copy or send

### 3. Feature highlights (icon + 1-liner each)
- **ETA replies** — pulls live journey time from Google Maps, no guessing
- **Availability replies** — checks your calendar before saying "I'm free"
- **Style learning** — adapts to how you actually write over time
- **3 tones** — Brief, Casual, Formal — pick per reply
- **Works across apps** — WhatsApp, iMessage (via Share), Telegram, Messenger
- **Private by default** — suggestions never stored, API key never on-device

### 4. Privacy callout (important for trust)
Short section, 2–3 sentences:
"Your messages never leave your device. Suggestions are generated in real time and immediately discarded. We don't store message content, contacts, or your location history."

### 5. Waitlist CTA (repeat at bottom)
"Android beta launching soon. Be first."
Email input + button.

---

## Tech Stack
**Recommendation: Astro + Tailwind CSS, deployed to Cloudflare Pages**
- Static output — zero JS by default, fast
- Cloudflare Pages free tier — same account as the Worker proxy
- Waitlist emails → Cloudflare Worker POST → store in D1 or forward to Resend/Mailchimp

Alternative if speed matters more: plain HTML/CSS in a `/website` folder, deploy anywhere.

---

## Waitlist Flow
```
User enters email → POST to Cloudflare Worker /waitlist
Worker → stores in D1 (emails table)
Worker → sends confirmation email via Resend (free tier)
User sees: "You're on the list. We'll email you when Android beta opens."
```

Launch email: single email when internal test track opens on Play Store.

---

## Design Direction
- Dark theme (matches the app — BG `#0c0c0e`, accent `#6366f1` indigo)
- Phone mockup as hero visual — show the bubble UI, not abstract graphics
- Logo: minimal circuit-bubble mark (from `assets/` SVG concepts)
- Font: system font stack or Inter — no custom fonts needed pre-launch
- Mobile-first layout

---

## Content to Write
- [ ] Final app name confirmed → update all copy
- [ ] Hero headline / subhead (2–3 variants to A/B)
- [ ] Privacy policy page (required before Play Store submission — covers NLS, Accessibility, Google data)
- [ ] Waitlist confirmation email copy

---

## Launch Checklist
- [ ] Name decided
- [ ] Domain purchased
- [ ] Site built and deployed to Cloudflare Pages
- [ ] Waitlist Worker endpoint live
- [ ] Privacy policy page live (needed for Play Store listing)
- [ ] Share link ready for social / Product Hunt teaser

---

## What this site is NOT
- Not a docs site — no API or developer docs needed yet
- Not a pricing page — freemium decision not made, don't commit publicly yet
- Not a blog — no content strategy pre-launch
