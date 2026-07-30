import { NativeModules } from 'react-native';
import { updateContactCloseness } from './database';

interface ConfirmedLink {
  convKey: string;
  contactId: string;
  displayName: string;
  platform: string;
}

// Rolls a contact's per-platform closeness signals (recency/frequency/reply-speed,
// computed natively in ContactSignals.kt) up into one contact-level score, and persists
// it via updateContactCloseness. Uses max() across platforms rather than an average — a
// linked platform with no data yet isn't evidence of distance, and someone who's very
// close on WhatsApp but has never messaged on a newly-linked Telegram shouldn't have
// that closeness diluted by it. Returns null (and writes nothing) if no linked platform
// has enough signal data to score yet.
export async function recomputeClosenessScore(contactId: string): Promise<number | null> {
  try {
    const linksJson: string = await NativeModules.ProTxtSettings?.getAllConfirmedLinks?.();
    if (!linksJson) return null;
    const links = JSON.parse(linksJson) as ConfirmedLink[];
    const convKeys = links.filter((l) => l.contactId === contactId).map((l) => l.convKey);
    if (convKeys.length === 0) return null;

    const scoresJson: string = await NativeModules.ProTxtSettings?.getClosenessScores?.(JSON.stringify(convKeys));
    if (!scoresJson) return null;
    const scores = JSON.parse(scoresJson) as Record<string, number>;
    const values = Object.values(scores);
    if (values.length === 0) return null;

    const closeness = Math.max(...values);
    await updateContactCloseness(contactId, closeness);
    return closeness;
  } catch {
    return null;
  }
}
