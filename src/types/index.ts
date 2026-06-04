export type Intent = 'eta' | 'availability' | 'other';

export interface EtaData {
  duration: string;
  durationSeconds: number;
  distance: string;
  routeSummary: string;
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

export interface SuggestReplyInput {
  originalMessage: string;
  intent: Intent;
  etaData?: EtaData;
  availabilityData?: AvailabilityData;
}
