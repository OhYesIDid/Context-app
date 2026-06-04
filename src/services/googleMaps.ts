import type { EtaData } from '../types';

const API_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;
// Override these in .env to match your actual journey
const ORIGIN = process.env.EXPO_PUBLIC_MAPS_ORIGIN ?? '51.5074,-0.1278';
const DESTINATION = process.env.EXPO_PUBLIC_MAPS_DESTINATION ?? '51.5033,-0.0865';

const REQUEST_TIMEOUT_MS = 15_000;

export async function getEtaData(): Promise<EtaData> {
  if (!API_KEY) {
    throw new Error(
      'Google Maps API key missing. Add EXPO_PUBLIC_GOOGLE_MAPS_API_KEY to your .env file.'
    );
  }

  const params = new URLSearchParams({
    origin: ORIGIN,
    destination: DESTINATION,
    departure_time: 'now',
    key: API_KEY,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/directions/json?${params}`,
      { signal: controller.signal }
    );
    const data = await res.json();

    if (data.status !== 'OK') {
      throw new Error(
        `Google Maps error: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`
      );
    }

    const leg = data.routes[0].legs[0];
    // duration_in_traffic is only present when departure_time is set and traffic data exists
    const duration = leg.duration_in_traffic ?? leg.duration;

    return {
      duration: duration.text,
      durationSeconds: duration.value,
      distance: leg.distance.text,
      routeSummary: data.routes[0].summary,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Maps request timed out — check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
