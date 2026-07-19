import { detectIntents, requiredEnrichments, summariseEnrichments } from '../intentDetector';
import type { EnrichmentData } from '../../types';

describe('detectIntents', () => {
  it('detects eta from arrival/ETA phrasing', () => {
    expect(detectIntents('how long until you get here?')).toEqual(['eta']);
    expect(detectIntents("what's your eta")).toEqual(['eta']);
    expect(detectIntents('are you almost here')).toEqual(['eta']);
  });

  it('detects availability from free/busy/day phrasing', () => {
    expect(detectIntents('are you free tomorrow?')).toEqual(['availability']);
    expect(detectIntents('what does your schedule look like this week')).toEqual(['availability']);
  });

  it('detects booking from travel/reservation phrasing', () => {
    expect(detectIntents("what's the hotel confirmation number")).toEqual(['booking']);
    expect(detectIntents('has the parcel arrived yet')).toEqual(['booking']);
  });

  it('detects location_share when the other person is asked to share their location', () => {
    expect(detectIntents('can you send your location')).toEqual(['location_share']);
    expect(detectIntents('where r u')).toEqual(['location_share']);
  });

  it('detects incoming_location from map links, pin emoji, or raw coordinates', () => {
    expect(detectIntents('here: https://maps.google.com/?q=51.5,0.1')).toEqual(['incoming_location']);
    expect(detectIntents("meet me here 📍")).toEqual(['incoming_location']);
    expect(detectIntents('51.50735, -0.12776')).toEqual(['incoming_location']);
  });

  it('matches case-insensitively', () => {
    expect(detectIntents('ARE YOU FREE TOMORROW?')).toEqual(['availability']);
  });

  it('returns multiple intents when a message matches more than one category', () => {
    const intents = detectIntents('are you free tomorrow, and how long till you get here?');
    expect(intents).toEqual(expect.arrayContaining(['availability', 'eta']));
    expect(intents).toHaveLength(2);
  });

  it('falls back to general only when nothing more specific matched', () => {
    expect(detectIntents('happy birthday!')).toEqual(['general']);
  });

  it('does not report general when a more specific intent already matched', () => {
    // "event" alone would match the general pattern, but "arrive" matches eta first —
    // general must never appear alongside a specific intent.
    const intents = detectIntents('what time do you arrive at the event?');
    expect(intents).not.toContain('general');
    expect(intents).toContain('eta');
  });

  it('falls back to other when nothing matches at all', () => {
    expect(detectIntents('lol nice')).toEqual(['other']);
  });

  it('returns other for an empty message', () => {
    expect(detectIntents('')).toEqual(['other']);
  });
});

describe('requiredEnrichments', () => {
  it('maps a single intent to its declared enrichments', () => {
    expect(requiredEnrichments(['eta'])).toEqual(['maps']);
    expect(requiredEnrichments(['booking'])).toEqual(['bookings']);
    expect(requiredEnrichments(['other'])).toEqual([]);
  });

  it('dedupes enrichments shared across multiple intents', () => {
    // both 'availability' and 'general' require 'calendar'
    expect(requiredEnrichments(['availability', 'general'])).toEqual(['calendar']);
  });

  it('unions enrichments across distinct intents in first-seen order', () => {
    expect(requiredEnrichments(['eta', 'availability'])).toEqual(['maps', 'calendar']);
  });

  it('returns an empty array for no intents', () => {
    expect(requiredEnrichments([])).toEqual([]);
  });
});

describe('summariseEnrichments', () => {
  it('summarises maps data with duration/destination/distance', () => {
    const data: EnrichmentData = {
      maps: { duration: '12 min', distance: '4.3 mi', routeSummary: 'A10', destinationLabel: 'the office' },
    };
    expect(summariseEnrichments(data)).toBe('12 min to the office · 4.3 mi via A10');
  });

  it('omits the maps line when only a currentLocation fallback is available', () => {
    const data: EnrichmentData = {
      maps: { duration: '12 min', distance: '4.3 mi', routeSummary: 'A10', currentLocation: 'Shoreditch' },
    };
    expect(summariseEnrichments(data)).toBe('');
  });

  it('reports zero calendar events distinctly from one or many', () => {
    expect(summariseEnrichments({ calendar: { events: [], windowStart: '', windowEnd: '' } }))
      .toBe('No events in the next 7 days');
    expect(summariseEnrichments({ calendar: { events: [{} as any], windowStart: '', windowEnd: '' } }))
      .toBe('1 event in the next 7 days');
    expect(summariseEnrichments({ calendar: { events: [{} as any, {} as any], windowStart: '', windowEnd: '' } }))
      .toBe('2 events in the next 7 days');
  });

  it('joins maps and calendar summaries when both are present', () => {
    const data: EnrichmentData = {
      maps: { duration: '12 min', distance: '4.3 mi', routeSummary: 'A10', destinationLabel: 'the office' },
      calendar: { events: [], windowStart: '', windowEnd: '' },
    };
    expect(summariseEnrichments(data)).toBe('12 min to the office · 4.3 mi via A10 · No events in the next 7 days');
  });

  it('returns an empty string when no relevant enrichments are present', () => {
    expect(summariseEnrichments({})).toBe('');
  });
});
