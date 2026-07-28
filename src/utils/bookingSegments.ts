import type { BookingSegment } from '../types';

/**
 * Collapses a booking's segments down to the single travelDate/travelDateEnd/
 * destination shape older code (native bubble matching, trip-window
 * clustering, subtitle formatting) already understands — so those call sites
 * don't need to know segments exist. `destination` is the first segment's
 * `to` (falling back to `from`), matching the pre-segment classifier's
 * "first thing it found" behavior.
 */
export function deriveTravelSummary(segments: BookingSegment[] | undefined): {
  travelDate?: string;
  travelDateEnd?: string;
  destination?: string;
} {
  if (!segments || segments.length === 0) return {};
  const dates = segments.flatMap((s) => [s.date, s.endDate]).filter((d): d is string => !!d).sort();
  if (dates.length === 0) return {};
  const travelDate = dates[0];
  const last = dates[dates.length - 1];
  const destination = segments.find((s) => s.to)?.to ?? segments.find((s) => s.from)?.from;
  return { travelDate, travelDateEnd: last !== travelDate ? last : undefined, destination };
}

/** "GRU → SLZ", or just "São Luís" when only one side of the leg is known. */
export function formatSegmentRoute(segment: BookingSegment): string {
  if (segment.from && segment.to) return `${segment.from} → ${segment.to}`;
  return segment.to ?? segment.from ?? 'Details in email';
}

function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today · 14:30", "Tomorrow", or "Wed 30 Aug · 09:15" — day-relative, with the segment's time appended when known. */
export function formatSegmentSubtitle(segment: BookingSegment): string {
  const date = new Date(segment.date);
  const todayMs = dayStart(new Date());
  const eventMs = dayStart(date);
  const dayLabel = eventMs === todayMs
    ? 'Today'
    : eventMs === todayMs + 86400000
      ? 'Tomorrow'
      : date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return segment.time ? `${dayLabel} · ${segment.time}` : dayLabel;
}

/**
 * Builds a trip's headline from every segment it contains, in chronological
 * order, deduping consecutive repeats (e.g. a return leg landing back where
 * an earlier leg started) — "São Paulo → São Luís → Jericoacoara" instead of
 * whichever single flight's destination happened to be found first.
 * Appends country when every segment resolved to the same one, or lists the
 * distinct countries visited when the trip crosses borders.
 */
export function buildMultiCityDestination(segments: BookingSegment[]): string | null {
  // Only a segment with BOTH `from` and `to` is a real directional leg
  // (flight/train/bus/car) whose route can be chained. Destination-only
  // segments (hotels, events, or a pre-migration cached row's synthesized
  // single-segment fallback — see database.ts) are excluded: matching a
  // hotel's freeform destination text against a flight's route by string
  // equality is unreliable — the same reason trip GROUPING itself clusters
  // by date range rather than destination text (see groupIntoTrips).
  const legs = segments.filter((s) => s.from && s.to);
  if (legs.length === 0) return null;

  const places: { city: string; country?: string }[] = [];
  for (const leg of legs) {
    if (places[places.length - 1]?.city !== leg.from) places.push({ city: leg.from!, country: leg.fromCountry });
    if (places[places.length - 1]?.city !== leg.to) places.push({ city: leg.to!, country: leg.toCountry });
  }

  const cityPath = places.map((p) => p.city).join(' → ');
  const countries = [...new Set(places.map((p) => p.country).filter((c): c is string => !!c))];
  if (countries.length === 1) return `${cityPath}, ${countries[0]}`;
  if (countries.length > 1) return `${cityPath} (${countries.join(', ')})`;
  return cityPath;
}
