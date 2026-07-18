import type { Enrichment, EnrichmentData, Intent } from '../types';
import intentPatternSource from '../../assets/intent_patterns.json';

// Single source of truth for intent-classification regexes — shared with
// ProTxtBgService.kt (via the copyIntentPatterns Gradle task) and
// worker/src/index.ts's fallback detectIntents. Edit assets/intent_patterns.json,
// not the pattern lists below, and keep all three consumers' detectIntents logic
// (match order, general-only-as-fallback) in sync.
function compilePatterns(key: keyof typeof intentPatternSource): RegExp[] {
  return intentPatternSource[key].map((p) => new RegExp(p, 'i'));
}

// ── Enrichment preference schema ──────────────────────────────────────────────

export interface EnrichmentPrefOption {
  value: string;
  label: string;
}

export interface EnrichmentPrefField {
  key: string;
  label: string;
  options: EnrichmentPrefOption[];
  defaultValue: string;
}

// Declares what user-configurable preferences each enrichment exposes.
// The Settings UI renders this generically — add new enrichments here.
export const ENRICHMENT_PREFERENCES: Partial<Record<keyof EnrichmentData, EnrichmentPrefField[]>> = {
  bookings: [
    {
      key: 'lookbackDays',
      label: 'Search window',
      options: [
        { value: '14', label: '2 weeks' },
        { value: '30', label: '1 month' },
        { value: '90', label: '3 months' },
      ],
      defaultValue: '30',
    },
  ],
  maps: [
    {
      key: 'transportMode',
      label: 'Transport mode',
      options: [
        { value: 'driving',   label: 'Driving'  },
        { value: 'walking',   label: 'Walking'  },
        { value: 'transit',   label: 'Transit'  },
        { value: 'bicycling', label: 'Cycling'  },
      ],
      defaultValue: 'driving',
    },
  ],
};

const ETA_PATTERNS = compilePatterns('eta');
const AVAILABILITY_PATTERNS = compilePatterns('availability');
const BOOKING_PATTERNS = compilePatterns('booking');
const LOCATION_SHARE_PATTERNS = compilePatterns('location_share');
const INCOMING_LOCATION_PATTERNS = compilePatterns('incoming_location');
const GENERAL_PATTERNS = compilePatterns('general');

// Which enrichments each intent requires. Add new intents and their data
// sources here — call sites loop over this instead of branching per-intent.
export const INTENT_ENRICHMENTS: Record<Intent, Enrichment[]> = {
  eta:               ['maps'],
  availability:      ['calendar'],
  booking:           ['bookings'],
  // No live GPS plumbed into this (paste-message/share-sheet) path yet — the
  // notification-listener path resolves this via native LocationManager instead.
  location_share:    [],
  incoming_location: ['incoming_location'],
  general:           ['calendar'],
  other:             [],
};

// Human-readable status shown while fetching each enrichment.
export const ENRICHMENT_STATUS: Record<Enrichment, string> = {
  maps:              'Fetching journey time…',
  calendar:          'Checking your calendar…',
  bookings:          'Checking your bookings…',
  incoming_location: 'Looking up shared location…',
};

const BOOKING_TYPE_LABEL: Record<string, string> = {
  flight: 'Flight', hotel: 'Hotel', train: 'Train', bus: 'Bus',
  delivery: 'Delivery', restaurant: 'Restaurant', event: 'Event', other: 'Booking',
};

// Formatters that turn enrichment data into a context string for the prompt. Single
// source of truth — shared with worker/src/index.ts, which imports this directly
// instead of maintaining its own copy (they'd previously drifted: the worker had
// location_coords/emotion formatters and a currentLocation-aware maps formatter that
// this file didn't have at all).
// Adding a new enrichment = adding one entry here; nothing else changes.
export const ENRICHMENT_FORMATTERS: {
  [K in keyof EnrichmentData]-?: (data: NonNullable<EnrichmentData[K]>) => string;
} = {
  location_coords: (d) =>
    `User's current GPS coordinates: ${d.lat.toFixed(5)},${d.lon.toFixed(5)}. They can share a Google Maps link: https://maps.google.com/?q=${d.lat.toFixed(5)},${d.lon.toFixed(5)}`,
  maps: (d) => {
    if (d.currentLocation) {
      return `User is currently in: ${d.currentLocation}. No routable destination was extracted from the conversation — use this location in the reply (e.g. "I'm in ${d.currentLocation}") and give a natural response. Do NOT ask them to drop a pin.`;
    }
    const locationLink = (d.userLat != null && d.userLon != null)
      ? ` End the reply with your current location on a new line: https://maps.google.com/?q=${d.userLat.toFixed(5)},${d.userLon.toFixed(5)}`
      : '';
    return `Real-time travel data: currently ${d.duration} away from ${d.destinationLabel ?? 'destination'} (${d.distance}) via ${d.routeSummary}. Always include this travel time in the reply. If the conversation states or implies a specific meeting/arrival time, work out whether ${d.duration} from now means arriving after that time — if so, say so honestly (e.g. "running about 10 min late") rather than assuming you'll be on time without checking.${locationLink}`;
  },
  mapsCandidates: (d) => {
    // mentionedMinutesAgo ~0 means this candidate came from an imminent booking, not something
    // actually said in the thread (see BookingDestinations.kt) — the label itself already carries
    // that context (e.g. "Brighton (train today)"), so skip the recency clause rather than claim
    // a booking was "mentioned" moments ago.
    const lines = d.map((c) => {
      const recency = c.mentionedMinutesAgo < 2
        ? ''
        : `, mentioned ${c.mentionedMinutesAgo < 60 ? `${c.mentionedMinutesAgo} min` : `${Math.round(c.mentionedMinutesAgo / 60)}h`} ago`;
      return `  • ${c.label}: ${c.duration} away (${c.distance})${recency}`;
    }).join('\n');
    return `Multiple possible destinations are relevant here — either mentioned earlier in this conversation or from an upcoming booking — and the thread doesn't make it obvious which one this message is asking about. Use conversation context to judge which is most likely, and include that destination's real travel time in the reply:\n${lines}`;
  },
  tripReturn: (d) => {
    const label = (BOOKING_TYPE_LABEL[d.type] ?? 'Trip').toLowerCase();
    const dateStr = new Date(d.returnDate).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
    return `Separately from any live travel-time data above: the user has a ${label} booking to ${d.destination} that returns/ends on ${dateStr}. If this message is asking when they'll be BACK or return from ${d.destination} — not how far away they currently are — answer using this return date instead of the live travel time.`;
  },
  bookings: (d) => {
    if (d.items.length === 0) return 'No recent travel or purchase emails found.';
    const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const lines = d.items.slice(0, 8).map((item) => {
      const label = BOOKING_TYPE_LABEL[item.type] ?? 'Booking';
      let dateStr: string;
      if (item.travelDate) {
        dateStr = item.travelDateEnd && item.travelDateEnd !== item.travelDate
          ? `travel ${fmt(item.travelDate)} – ${fmt(item.travelDateEnd)}`
          : `travel ${fmt(item.travelDate)}`;
      } else {
        dateStr = `confirmation received ${fmt(item.date)}, travel date unclear`;
      }
      return `  • [${label}] ${item.subject} (${dateStr}) — ${item.snippet.slice(0, 120)}`;
    }).join('\n');
    return `Recent bookings and reservations (${d.items.length} found). Use the "travel" date as the actual trip date — the "confirmation received" date is just when the booking email arrived and is NOT the travel date:\n${lines}`;
  },
  calendar: (d) => {
    if (d.events.length === 0) return 'User has no calendar events in the next 7 days — completely free.';
    const fmt = (iso: string) =>
      new Date(iso).toLocaleString('en-GB', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    const lines = d.events.slice(0, 15).map((e) => {
      if (e.allDay) {
        const day = new Date(e.start).toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' });
        return `  • ${day} — ${e.summary} (all day)`;
      }
      const endTime = new Date(e.end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return `  • ${fmt(e.start)} → ${endTime} — ${e.summary}`;
    }).join('\n');
    return `User's calendar events in the next 7 days (${d.events.length} total):\n${lines}`;
  },
  emotion: (d) => {
    const guidance: Record<string, string> = {
      anger:       'The sender appears angry or upset. Acknowledge their frustration genuinely before responding — avoid being defensive.',
      urgency:     'The sender needs a quick response. Be direct and skip pleasantries.',
      anxiety:     'The sender seems worried or stressed. Lead with reassurance before giving details.',
      frustration: 'The sender seems frustrated. Acknowledge their concern before addressing the content.',
      passive_agg: 'The sender may be expressing displeasure indirectly. Be warm and non-confrontational.',
    };
    const hint = guidance[d.emotion];
    if (!hint) return '';
    return d.confidence === 'high' ? hint : `Note (low confidence): ${hint}`;
  },
  incoming_location: (d) => {
    if (d.lat != null && d.lon != null) {
      const coord = `${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`;
      const place = d.placeLabel ? `${d.placeLabel} (${coord})` : coord;
      return `The other person has shared their location: ${place}. They may be waiting for you, sharing a meeting point, or providing directions. Respond naturally — acknowledge the pin and offer relevant context (your ETA, whether you're heading there, etc.).`;
    }
    if (d.nativePin) {
      return `The other person has shared their location via a native pin. No coordinates are available in the notification. Acknowledge the share naturally — they may be waiting for you or sharing a meeting point.`;
    }
    return `The other person has shared a location link. Acknowledge the share and respond naturally.`;
  },
};

/** Returns all matching intents for a message. Falls back to ['other']. */
export function detectIntents(message: string): Intent[] {
  const intents: Intent[] = [];
  if (ETA_PATTERNS.some((re) => re.test(message))) intents.push('eta');
  if (AVAILABILITY_PATTERNS.some((re) => re.test(message))) intents.push('availability');
  if (BOOKING_PATTERNS.some((re) => re.test(message))) intents.push('booking');
  if (LOCATION_SHARE_PATTERNS.some((re) => re.test(message))) intents.push('location_share');
  if (INCOMING_LOCATION_PATTERNS.some((re) => re.test(message))) intents.push('incoming_location');
  // general is a fallback signal only — anything more specific above takes priority.
  if (intents.length === 0 && GENERAL_PATTERNS.some((re) => re.test(message))) intents.push('general');
  return intents.length > 0 ? intents : ['other'];
}

/** Deduped list of enrichments required across all detected intents. */
export function requiredEnrichments(intents: Intent[]): Enrichment[] {
  return [...new Set(intents.flatMap((i) => INTENT_ENRICHMENTS[i]))];
}

/** Build a human-readable summary of enrichment results for the UI. */
export function summariseEnrichments(enrichments: EnrichmentData): string {
  const parts: string[] = [];
  if (enrichments.maps && !enrichments.maps.currentLocation) {
    const { duration, destinationLabel, distance, routeSummary } = enrichments.maps;
    parts.push(`${duration} to ${destinationLabel ?? 'destination'} · ${distance} via ${routeSummary}`);
  }
  if (enrichments.calendar) {
    const n = enrichments.calendar.events.length;
    parts.push(n === 0 ? 'No events in the next 7 days' : `${n} event${n !== 1 ? 's' : ''} in the next 7 days`);
  }
  return parts.join(' · ');
}
