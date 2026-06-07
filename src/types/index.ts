export type Intent = 'eta' | 'availability' | 'other';
export type Tone = 'formal' | 'casual' | 'brief';
export type Relationship = 'colleague' | 'friend' | 'family' | 'flatmate' | 'partner' | 'other';
export type MemoryType = 'episodic' | 'semantic' | 'spatial' | 'relational' | 'conversation_history';
export type Platform = 'whatsapp' | 'telegram' | 'instagram' | 'sms' | 'email' | 'messenger' | 'signal' | 'google' | 'phone';
export type IdentifierType = 'phone' | 'username' | 'email';

export interface ReplyOptions {
  formal: string;
  casual: string;
  brief: string;
}

export interface EtaData {
  duration: string;
  durationSeconds: number;
  distance: string;
  routeSummary: string;
  destinationLabel: string;
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

export interface ConversationMessage {
  sender: string | null;
  text: string;
}

export interface SuggestReplyInput {
  originalMessage: string;
  intent: Intent;
  conversationThread?: ConversationMessage[];
  etaData?: EtaData;
  availabilityData?: AvailabilityData;
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
  createdAt: string;
  syncedAt?: string;
}
