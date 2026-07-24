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

  it('detects availability from a bare calendar date with no day-of-week or "free/busy" wording', () => {
    // Regression: "How about the 25th?" was falling through to 'other', so no reply was
    // ever suggested for a message that only proposes a date this way.
    expect(detectIntents('How about the 25th?')).toEqual(['availability']);
    expect(detectIntents('lets do July 25th')).toEqual(['availability']);
    expect(detectIntents('are you free on the 25th')).toEqual(['availability']);
    expect(detectIntents('lets meet on the 3rd of august')).toEqual(['availability']);
    expect(detectIntents('how about 3rd August')).toEqual(['availability']);
    expect(detectIntents('whats on the 1st')).toEqual(['availability']);
  });

  it('does not treat an ordinal number alone as a calendar-date reference', () => {
    expect(detectIntents('I came 2nd in the race')).toEqual(['other']);
    expect(detectIntents('he came 1st place')).toEqual(['other']);
    expect(detectIntents('my 25th year at the company')).toEqual(['other']);
  });

  it('detects task from explicit follow-up/reminder/calendar-add phrasing', () => {
    // Regression: these previously fell through to 'other', which silently skips the
    // whole worker call for non-Pro/non-suggest_all users — see the event/reminder
    // recognition research (recommendation #1). Some examples legitimately also match
    // an existing category (e.g. "calendar", "next week", "Friday afternoon" are already
    // availability keywords) — asserting containment, not exclusivity.
    expect(detectIntents('Can you send me the venue address by tomorrow?')).toContain('task');
    expect(detectIntents("Don't forget to bring the tickets")).toEqual(['task']);
    expect(detectIntents('remember to pick up the dry cleaning')).toEqual(['task']);
    expect(detectIntents('add this to your calendar')).toContain('task');
    expect(detectIntents('set a reminder for 6pm')).toEqual(['task']);
    expect(detectIntents('remind me to call mum')).toEqual(['task']);
    expect(detectIntents("let's schedule a call next week")).toContain('task');
    expect(detectIntents('block off Friday afternoon')).toContain('task');
    expect(detectIntents('make sure you bring your passport')).toEqual(['task']);
  });

  it('does not treat a reminiscence or rhetorical "should" as a task', () => {
    expect(detectIntents('that reminds me of a great story')).toEqual(['other']);
    // "catch up" alone already matches the existing availability pattern — not a task
    // regression, just confirms the new task patterns don't ALSO fire here.
    expect(detectIntents('we really should hang out more')).toEqual(['other']);
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

  it('maps task to calendar so a proposed event can be deduped against existing ones', () => {
    expect(requiredEnrichments(['task'])).toEqual(['calendar']);
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
