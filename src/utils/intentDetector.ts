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

// Formatters that turn enrichment data into a context string for the prompt.
// Adding a new enrichment = adding one entry here; nothing else changes.
export const ENRICHMENT_FORMATTERS: {
  [K in keyof EnrichmentData]-?: (data: NonNullable<EnrichmentData[K]>) => string;
} = {
  maps: (d) =>
    `Real-time travel data: currently ${d.duration} away from ${d.destinationLabel} (${d.distance}) via ${d.routeSummary}.`,
  bookings: (d) => {
    if (d.items.length === 0) return 'No recent travel or purchase emails found.';
    const TYPE_LABEL: Record<string, string> = {
      flight: 'Flight', hotel: 'Hotel', train: 'Train',
      delivery: 'Delivery', restaurant: 'Restaurant', event: 'Event', other: 'Booking',
    };
    const lines = d.items.slice(0, 8).map((item) => {
      const label = TYPE_LABEL[item.type] ?? 'Booking';
      const date = new Date(item.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      return `  • [${label}] ${item.subject} (${date}) — ${item.snippet.slice(0, 120)}`;
    }).join('\n');
    return `Recent bookings and reservations (${d.items.length} found):\n${lines}`;
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
  incoming_location: (d) => {
    if (d.lat != null && d.lon != null) {
      const coord = `${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`;
      const place = d.placeLabel ? `${d.placeLabel} (${coord})` : coord;
      return `The other person has shared their location: ${place}. They may be waiting for you or providing a meeting point.`;
    }
    if (d.nativePin) {
      return `The other person has shared a location pin. No coordinates available from the notification — acknowledge naturally.`;
    }
    return `The other person has shared a location link.`;
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
  if (enrichments.maps) {
    const { duration, destinationLabel, distance, routeSummary } = enrichments.maps;
    parts.push(`${duration} to ${destinationLabel} · ${distance} via ${routeSummary}`);
  }
  if (enrichments.calendar) {
    const n = enrichments.calendar.events.length;
    parts.push(n === 0 ? 'No events in the next 7 days' : `${n} event${n !== 1 ? 's' : ''} in the next 7 days`);
  }
  return parts.join(' · ');
}
