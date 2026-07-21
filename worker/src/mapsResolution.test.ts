import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveDirections, resolveMapsEnrichments, type EnrichmentDataWithMapsRequest } from './index';

function mockDirectionsResponse(overrides: Record<string, any> = {}) {
  return {
    status: 'OK',
    routes: [{
      summary: 'A10',
      legs: [{ duration: { text: '12 mins' }, distance: { text: '4.3 mi' } }],
    }],
    ...overrides,
  };
}

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveDirections', () => {
  it('parses a successful Directions API response', async () => {
    (global.fetch as any).mockResolvedValue({ json: async () => mockDirectionsResponse() });

    const result = await resolveDirections({ lat: 51.5, lon: -0.1 }, 'the office', 'driving', 'key123');

    expect(result).toEqual({ duration: '12 mins', distance: '4.3 mi', routeSummary: 'A10' });
  });

  it('prefers duration_in_traffic over duration when both are present', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => mockDirectionsResponse({
        routes: [{ summary: 'A10', legs: [{ duration: { text: '12 mins' }, duration_in_traffic: { text: '18 mins' }, distance: { text: '4.3 mi' } }] }],
      }),
    });

    const result = await resolveDirections({ lat: 51.5, lon: -0.1 }, 'the office', 'driving', 'key123');

    expect(result?.duration).toBe('18 mins');
  });

  it('returns null when the API reports a non-OK status', async () => {
    (global.fetch as any).mockResolvedValue({ json: async () => mockDirectionsResponse({ status: 'ZERO_RESULTS', routes: [] }) });

    const result = await resolveDirections({ lat: 51.5, lon: -0.1 }, 'nonexistent place', 'driving', 'key123');

    expect(result).toBeNull();
  });

  it('returns null when fetch itself throws (network error, abort, etc.)', async () => {
    (global.fetch as any).mockRejectedValue(new Error('network error'));

    const result = await resolveDirections({ lat: 51.5, lon: -0.1 }, 'the office', 'driving', 'key123');

    expect(result).toBeNull();
  });

  it('includes departure_time=now for driving mode only', async () => {
    (global.fetch as any).mockResolvedValue({ json: async () => mockDirectionsResponse() });

    await resolveDirections({ lat: 51.5, lon: -0.1 }, 'the office', 'driving', 'key123');
    const drivingUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(drivingUrl).toContain('departure_time=now');

    await resolveDirections({ lat: 51.5, lon: -0.1 }, 'the office', 'walking', 'key123');
    const walkingUrl = (global.fetch as any).mock.calls[1][0] as string;
    expect(walkingUrl).not.toContain('departure_time=now');
  });
});

describe('resolveMapsEnrichments', () => {
  it('is a no-op when no API key is configured', async () => {
    const enrichments: EnrichmentDataWithMapsRequest = {
      mapsRequest: { destination: 'the office', label: 'the office', originLat: 51.5, originLon: -0.1, mode: 'driving' },
    };

    const resolved = await resolveMapsEnrichments(enrichments, undefined);

    expect(resolved).toBeNull();
    expect(enrichments.maps).toBeUndefined();
    expect(enrichments.mapsRequest).toBeDefined(); // left untouched, not even cleaned up
  });

  it('is a no-op when neither mapsRequest nor mapsRequests is present', async () => {
    const enrichments: EnrichmentDataWithMapsRequest = { calendar: { events: [], windowStart: '', windowEnd: '' } };

    const resolved = await resolveMapsEnrichments(enrichments, 'key123');

    expect(resolved).toBeNull();
    expect(enrichments.maps).toBeUndefined();
  });

  it('resolves a single mapsRequest into enrichments.maps, removes the request field, and reports what resolved', async () => {
    (global.fetch as any).mockResolvedValue({ json: async () => mockDirectionsResponse() });
    const enrichments: EnrichmentDataWithMapsRequest = {
      mapsRequest: { destination: 'the office', label: 'the office', originLat: 51.5, originLon: -0.1, mode: 'driving' },
    };

    const resolved = await resolveMapsEnrichments(enrichments, 'key123');

    expect(enrichments.maps).toEqual({
      duration: '12 mins', distance: '4.3 mi', routeSummary: 'A10',
      destinationLabel: 'the office', userLat: 51.5, userLon: -0.1,
    });
    expect(enrichments.mapsRequest).toBeUndefined();
    expect(resolved).toEqual({ destinationText: 'the office', label: 'the office' });
  });

  it('leaves maps unset (but still removes the request field) and reports null when the single request fails to resolve', async () => {
    (global.fetch as any).mockResolvedValue({ json: async () => mockDirectionsResponse({ status: 'ZERO_RESULTS', routes: [] }) });
    const enrichments: EnrichmentDataWithMapsRequest = {
      mapsRequest: { destination: 'nowhere', label: 'nowhere', originLat: 51.5, originLon: -0.1, mode: 'driving' },
    };

    const resolved = await resolveMapsEnrichments(enrichments, 'key123');

    expect(enrichments.maps).toBeUndefined();
    expect(enrichments.mapsRequest).toBeUndefined();
    expect(resolved).toBeNull(); // critical: a failed/unvalidated destination must never be reported as resolved
  });

  it('resolves exactly one successful candidate into enrichments.maps, not mapsCandidates, and reports it', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce({ json: async () => mockDirectionsResponse({ status: 'ZERO_RESULTS', routes: [] }) })
      .mockResolvedValueOnce({ json: async () => mockDirectionsResponse() });
    const enrichments: EnrichmentDataWithMapsRequest = {
      mapsRequests: [
        { destination: 'invalid place', label: 'invalid place', mentionedMinutesAgo: 10 },
        { destination: 'the office', label: 'the office', mentionedMinutesAgo: 5 },
      ],
      mapsOrigin: { lat: 51.5, lon: -0.1, mode: 'driving' },
    };

    const resolved = await resolveMapsEnrichments(enrichments, 'key123');

    expect(enrichments.maps?.destinationLabel).toBe('the office');
    expect(enrichments.mapsCandidates).toBeUndefined();
    expect(enrichments.mapsRequests).toBeUndefined();
    expect(enrichments.mapsOrigin).toBeUndefined();
    expect(resolved).toEqual({ destinationText: 'the office', label: 'the office' });
  });

  it('resolves multiple successful candidates into mapsCandidates, preserving mentionedMinutesAgo, and reports null (ambiguous — nothing to record)', async () => {
    (global.fetch as any).mockResolvedValue({ json: async () => mockDirectionsResponse() });
    const enrichments: EnrichmentDataWithMapsRequest = {
      mapsRequests: [
        { destination: 'the office', label: 'the office', mentionedMinutesAgo: 5 },
        { destination: 'the station', label: 'the station', mentionedMinutesAgo: 20 },
      ],
      mapsOrigin: { lat: 51.5, lon: -0.1, mode: 'driving' },
    };

    const resolved = await resolveMapsEnrichments(enrichments, 'key123');

    expect(enrichments.maps).toBeUndefined();
    expect(enrichments.mapsCandidates).toHaveLength(2);
    expect(enrichments.mapsCandidates?.map((c) => c.mentionedMinutesAgo)).toEqual([5, 20]);
    expect(resolved).toBeNull(); // matches old behavior: ambiguous candidates were never recorded either
  });

  it('falls back to mapsFallbackLocation when none of the candidates resolve, and reports null', async () => {
    (global.fetch as any).mockResolvedValue({ json: async () => mockDirectionsResponse({ status: 'ZERO_RESULTS', routes: [] }) });
    const enrichments: EnrichmentDataWithMapsRequest = {
      mapsRequests: [{ destination: 'nowhere', label: 'nowhere', mentionedMinutesAgo: 5 }],
      mapsOrigin: { lat: 51.5, lon: -0.1, mode: 'driving' },
      mapsFallbackLocation: 'Shoreditch',
    };

    const resolved = await resolveMapsEnrichments(enrichments, 'key123');

    expect(enrichments.maps).toEqual({ currentLocation: 'Shoreditch' });
    expect(enrichments.mapsFallbackLocation).toBeUndefined();
    expect(resolved).toBeNull();
  });

  it('does nothing when none resolve and there is no fallback location', async () => {
    (global.fetch as any).mockResolvedValue({ json: async () => mockDirectionsResponse({ status: 'ZERO_RESULTS', routes: [] }) });
    const enrichments: EnrichmentDataWithMapsRequest = {
      mapsRequests: [{ destination: 'nowhere', label: 'nowhere', mentionedMinutesAgo: 5 }],
      mapsOrigin: { lat: 51.5, lon: -0.1, mode: 'driving' },
    };

    const resolved = await resolveMapsEnrichments(enrichments, 'key123');

    expect(enrichments.maps).toBeUndefined();
    expect(enrichments.mapsRequests).toBeUndefined();
    expect(enrichments.mapsOrigin).toBeUndefined();
    expect(resolved).toBeNull();
  });
});
