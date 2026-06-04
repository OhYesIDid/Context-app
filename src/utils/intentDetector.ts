import type { Intent } from '../types';

const ETA_PATTERNS = [
  /\beta\b/i,
  /when (will|are) you/i,
  /how (long|far)/i,
  /on (your|the) way/i,
  /(leaving|left) yet/i,
  /\b(arriving|arrive|arrival)\b/i,
  /where are you/i,
  /almost (here|there)/i,
  /how (close|soon)/i,
  /time will you/i,
];

const AVAILABILITY_PATTERNS = [
  /\b(free|available|availability)\b/i,
  /\b(busy|schedule|calendar)\b/i,
  /\b(meeting|catch[- ]?up|call|chat)\b/i,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(this|next) (week|weekend|morning|afternoon|evening)\b/i,
  /\btomorrow\b/i,
  /\btonight\b/i,
  /are you (around|up for|down for)/i,
];

export function detectIntent(message: string): Intent {
  if (ETA_PATTERNS.some((re) => re.test(message))) return 'eta';
  if (AVAILABILITY_PATTERNS.some((re) => re.test(message))) return 'availability';
  return 'other';
}
