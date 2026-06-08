import type { Enrichment, EnrichmentData, Intent } from '../types';

const ETA_PATTERNS = [
  /\beta\b/i,
  /when (will|are) you/i,
  /how (long|far)/i,
  /on (your|the) way/i,
  /(leaving|left) yet/i,
  /\b(arriving|arrive|arrival)\b/i,
  /where are you/i,
  /almost (here|there)/i,
  /how (close|soon)/i,
  /time will you/i,
];

const AVAILABILITY_PATTERNS = [
  /\b(free|available|availability)\b/i,
  /\b(busy|schedule|calendar)\b/i,
  /\b(meeting|catch[- ]?up|call|chat)\b/i,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(this|next) (week|weekend|morning|afternoon|evening)\b/i,
  /\btomorrow\b/i,
  /\btonight\b/i,
  /are you (around|up for|down for)/i,
];

// Which enrichments each intent requires. Add new intents and their data
// sources here — call sites loop over this instead of branching per-intent.
export const INTENT_ENRICHMENTS: Record<Intent, Enrichment[]> = {
  eta:          ['maps'],
  availability: ['calendar'],
  other:        [],
};

// Human-readable status shown while fetching each enrichment.
export const ENRICHMENT_STATUS: Record<Enrichment, string> = {
  maps:     'Fetching journey time…',
  calendar: 'Checking your calendar…',
};

// Formatters that turn enrichment data into a context string for the prompt.
// Adding a new enrichment = adding one entry here; nothing else changes.
export const ENRICHMENT_FORMATTERS: {
  [K in keyof EnrichmentData]-?: (data: NonNullable<EnrichmentData[K]>) => string;
} = {
  maps: (d) =>
    `Real-time travel data: currently ${d.duration} away from ${d.destinationLabel} (${d.distance}) via ${d.routeSummary}.`,
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
};

/** Returns all matching intents for a message. Falls back to ['other']. */
export function detectIntents(message: string): Intent[] {
  const intents: Intent[] = [];
  if (ETA_PATTERNS.some((re) => re.test(message))) intents.push('eta');
  if (AVAILABILITY_PATTERNS.some((re) => re.test(message))) intents.push('availability');
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
