import * as Location from 'expo-location';
import type { EtaData } from '../types';
import { getWorkPlace } from './database';

const API_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;
const FALLBACK_DESTINATION = process.env.EXPO_PUBLIC_MAPS_DESTINATION ?? '51.5033,-0.0865';

const REQUEST_TIMEOUT_MS = 15_000;

export async function getEtaData(transportMode = 'driving'): Promise<EtaData> {
  if (!API_KEY) {
    throw new Error('Google Maps API key missing. Add EXPO_PUBLIC_GOOGLE_MAPS_API_KEY to your .env file.');
  }

  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') {
    throw new Error('Location permission is required for ETA. Please grant it in Settings.');
  }

  const position = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Balanced,
  });
  const origin = `${position.coords.latitude},${position.coords.longitude}`;

  // Use saved work place if available, otherwise fall back to env var
  const workPlace = await getWorkPlace().catch(() => null);
  const destination = workPlace
    ? `${workPlace.lat},${workPlace.lng}`
    : FALLBACK_DESTINATION;

  const destinationLabel = workPlace?.name ?? 'destination';

  const params = new URLSearchParams({
    origin,
    destination,
    mode: transportMode,
    ...(transportMode === 'driving' ? { departure_time: 'now' } : {}),
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
    const duration = leg.duration_in_traffic ?? leg.duration;

    return {
      duration: duration.text,
      durationSeconds: duration.value,
      distance: leg.distance.text,
      routeSummary: data.routes[0].summary,
      destinationLabel,
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
