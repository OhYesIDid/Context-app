import { NativeModules } from 'react-native';
import { getTopIntentForContact } from './database';
import type { Intent } from '../types';

interface ConfirmedLink {
  convKey: string;
  contactId: string;
  displayName: string;
  platform: string;
}

interface RawInsight {
  msgsLast7d: number;
  msgsPrior7d: number;
  avgReplySecs?: number;
  mostActiveHour?: number;
}

export interface ContactInsights {
  msgsLast7d: number;
  msgsPrior7d: number;
  avgReplySecs?: number;
  mostActiveHour?: number;
  topIntent?: Intent;
}

// Rolls a contact's per-platform raw signal data (native, one blob per linked convKey —
// see ContactSignals.kt's computeInsights) up into one contact-level view, plus the most
// common message intent (a separate JS-side aggregate over style_edits, same contact,
// unrelated data source). Message counts sum across platforms — total volume across
// every way they reach you. avgReplySecs/mostActiveHour come from whichever linked
// platform has the most last-7-day volume rather than an average across platforms,
// since averaging reply-speed across differently-scaled channels would be meaningless
// (e.g. a WhatsApp average diluted by one lone Telegram message).
export async function getContactInsights(contactId: string): Promise<ContactInsights | null> {
  const topIntent = (await getTopIntentForContact(contactId).catch(() => null)) ?? undefined;

  let perPlatform: RawInsight[] = [];
  try {
    const linksJson: string = await NativeModules.ProTxtSettings?.getAllConfirmedLinks?.();
    const links = linksJson ? (JSON.parse(linksJson) as ConfirmedLink[]) : [];
    const convKeys = links.filter((l) => l.contactId === contactId).map((l) => l.convKey);
    if (convKeys.length > 0) {
      const rawJson: string = await NativeModules.ProTxtSettings?.getContactInsightsRaw?.(JSON.stringify(convKeys));
      const raw = rawJson ? (JSON.parse(rawJson) as Record<string, RawInsight>) : {};
      perPlatform = Object.values(raw);
    }
  } catch {
    // Best-effort — fall through with whatever's already in hand (possibly just topIntent).
  }

  if (perPlatform.length === 0) {
    return topIntent ? { msgsLast7d: 0, msgsPrior7d: 0, topIntent } : null;
  }

  const richest = perPlatform.reduce((a, b) => (b.msgsLast7d > a.msgsLast7d ? b : a));
  return {
    msgsLast7d: perPlatform.reduce((sum, p) => sum + p.msgsLast7d, 0),
    msgsPrior7d: perPlatform.reduce((sum, p) => sum + p.msgsPrior7d, 0),
    avgReplySecs: richest.avgReplySecs,
    mostActiveHour: richest.mostActiveHour,
    topIntent,
  };
}
