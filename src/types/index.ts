export type Intent = 'eta' | 'availability' | 'other';

export interface EtaData {
  duration: string;
  durationSeconds: number;
  distance: string;
  routeSummary: string;
}

export interface BusySlot {
  start: string;
  end: string;
}

export interface AvailabilityData {
  busySlots: BusySlot[];
  windowStart: string;
  windowEnd: string;
}

export interface SuggestReplyInput {
  originalMessage: string;
  intent: Intent;
  etaData?: EtaData;
  availabilityData?: AvailabilityData;
}
