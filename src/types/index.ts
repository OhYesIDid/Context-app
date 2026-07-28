export type Intent = 'eta' | 'availability' | 'booking' | 'location_share' | 'incoming_location' | 'task' | 'general' | 'other';
export type Enrichment = 'maps' | 'calendar' | 'bookings' | 'incoming_location';
export type BookingType = 'flight' | 'hotel' | 'train' | 'bus' | 'car' | 'delivery' | 'restaurant' | 'event' | 'other';
export type Tone = 'formal' | 'casual' | 'brief';
export type Relationship = 'colleague' | 'friend' | 'family' | 'flatmate' | 'partner' | 'other';
export type MemoryType = 'episodic' | 'semantic' | 'spatial' | 'relational' | 'conversation_history';
export type Platform = 'whatsapp' | 'telegram' | 'instagram' | 'sms' | 'email' | 'messenger' | 'signal' | 'google' | 'phone';
export type IdentifierType = 'phone' | 'username' | 'email' | 'display_name';

export interface ReplyOptions {
  formal: string;
  casual: string;
  brief: string;
}

export interface EtaData {
  duration: string;
  durationSeconds?: number; // populated by googleMaps.ts's Distance Matrix path only
  distance: string;
  routeSummary: string;
  destinationLabel?: string;
  currentLocation?: string; // fallback when no destination could be resolved — current-area name only
  userLat?: number;
  userLon?: number;
}

// One of several recently-mentioned destinations in the same conversation, presented
// together when it's ambiguous which one a follow-up message ("how long will it take
// you?") actually refers to — Claude picks using the conversation context it already has.
export interface EtaCandidate {
  label: string;
  duration: string;
  distance: string;
  routeSummary: string;
  mentionedMinutesAgo: number;
}

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
}

export interface AvailabilityData {
  events: CalendarEvent[];
  windowStart: string;
  windowEnd: string;
}

// One leg or stay within a booking confirmation — a round-trip flight email
// resolves to TWO segments (outbound + return), not one date range, so a
// multi-city itinerary (flight in, ground transport to a second city, flight
// home from THAT city) can be represented instead of collapsed to a single
// "destination". See src/utils/bookingSegments.ts for the derivation this feeds.
export interface BookingSegment {
  from?: string;       // origin city/place — flight/train/bus origin, car pick-up. Omitted for hotels/events.
  fromCountry?: string;
  to?: string;          // destination city/place, hotel's city, car drop-off, or event location
  toCountry?: string;
  date: string;         // ISO string — departure/check-in/pick-up/event date
  endDate?: string;      // ISO string — end of a multi-day span (hotel checkout, car drop-off) only
  time?: string;         // local 24h "HH:MM", if the email stated one
}

export interface BookingItem {
  id: string;               // Gmail message ID — used as dedup key in Phase 2 local cache
  type: BookingType;
  subject: string;
  snippet: string;
  from: string;
  date: string;             // ISO string parsed from email Date header (when the confirmation arrived)
  segments?: BookingSegment[]; // per-leg/stay detail extracted by the worker's classifier — source of truth
  travelDate?: string;      // derived from segments (earliest date) — kept for callers that just need a single window
  travelDateEnd?: string;   // derived from segments (latest date/endDate), if it differs from travelDate
  destination?: string;     // derived from segments (first leg's `to`) — kept for callers that just need one place name
  relevanceFrom?: string;   // Phase 2: populated by local sync when booking activates
  relevanceUntil?: string;  // Phase 2: populated by local sync when booking expires
}

export interface BookingContext {
  items: BookingItem[];
  windowStart: string;
  windowEnd: string;
}

export interface IncomingLocationData {
  lat?: number;
  lon?: number;
  placeLabel?: string;
  shortUrl?: string;
  nativePin?: boolean;
}

// Populated alongside `maps` (not instead of it) when the resolved destination also matches
// a cached booking — lets the prompt distinguish "how far away right now" from "when do you
// get back", which otherwise both read as the same live-ETA question. See BookingDestinations.kt.
export interface TripReturnData {
  destination: string;
  type: string;
  returnDate: string; // ISO
}

export interface EnrichmentData {
  maps?: EtaData;
  // Present instead of `maps` when multiple recent destinations are ambiguous — see EtaCandidate.
  mapsCandidates?: EtaCandidate[];
  tripReturn?: TripReturnData;
  calendar?: AvailabilityData;
  bookings?: BookingContext;
  incoming_location?: IncomingLocationData;
  location_coords?: { lat: number; lon: number };
  emotion?: { emotion: string; confidence: 'high' | 'low' };
}

export interface ConversationMessage {
  sender: string | null;
  text: string;
}

export interface SuggestReplyInput {
  originalMessage: string;
  intents: Intent[];
  conversationThread?: ConversationMessage[];
  enrichments?: EnrichmentData;
}

// ── Saved places ──────────────────────────────────────────────────────────────

export interface SavedPlace {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  placeId?: string;
  isHome: boolean;
  isWork: boolean;
  createdAt: string;
  updatedAt: string;
  syncedAt?: string;
  deletedAt?: string;
}

// ── Contact identity graph ────────────────────────────────────────────────────

export interface Contact {
  id: string;
  displayName: string;
  relationship?: Relationship;
  preferredTone?: Tone;
  interactionCount?: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  syncedAt?: string;
  deletedAt?: string;
}

export interface PlatformIdentity {
  id: string;
  contactId: string;
  platform: Platform;
  identifier: string;
  identifierType: IdentifierType;
  confidence: number;
  userConfirmed: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Memory ────────────────────────────────────────────────────────────────────

export interface Memory {
  id: string;
  contactId?: string;
  type: MemoryType;
  content: string;
  entitiesJson?: string;
  locationLat?: number;
  locationLng?: number;
  locationName?: string;
  relevanceScore: number;
  lastConfirmedAt?: string;
  createdAt: string;
  updatedAt: string;
  syncedAt?: string;
  deletedAt?: string;
}

// ── Style learning ────────────────────────────────────────────────────────────

export interface StyleEdit {
  id: string;
  contactId?: string;
  originalSuggestion: string;
  userEdit: string;
  platform?: Platform;
  intent?: Intent;
  toneSelected?: string;
  editDeltaJson?: string;
  subintent?: string;
  dismissalContextJson?: string;
  createdAt: string;
  syncedAt?: string;
}
