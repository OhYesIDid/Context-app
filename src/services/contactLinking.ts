import { NativeModules } from 'react-native';

const { ProTxtSettings } = NativeModules;

// A sender ConTxt has seen (via the notification listener) but that has never been
// matched to a real contact — sitting under a synthetic "auto:" id in the native
// confirmed_identities map (see ContactLinking.kt.decideContactMatch). Shared between
// ContactDetailModal's per-contact "+ Link another app" picker and ContactsScreen's
// app-wide "Unlinked senders" list — both read the same native list, just scoped
// differently (one contact's missing platforms vs. everyone still unlinked).
export interface UnmatchedSender {
  convKey: string;
  displayName: string;
  platformLabel: string;
  platform: string;
}

export async function getUnmatchedSenders(): Promise<UnmatchedSender[]> {
  try {
    const json: string = await ProTxtSettings?.getUnmatchedSenders?.();
    return json ? (JSON.parse(json) as UnmatchedSender[]) : [];
  } catch {
    return [];
  }
}

export function linkSenderToContact(convKey: string, contactId: string): Promise<boolean> {
  return ProTxtSettings?.linkSenderToContact?.(convKey, contactId) ?? Promise.resolve(false);
}

// Reverses linkSenderToContact for every sender on this platform linked to this
// contact — the "undo" path native matching never had: without this, a mistaken or
// no-longer-wanted link had no way back except editing the SQLite DB directly.
export function unlinkPlatform(contactId: string, platform: string): Promise<boolean> {
  return ProTxtSettings?.unlinkPlatformFromContact?.(contactId, platform) ?? Promise.resolve(false);
}

/** One candidate contact for a pending suggestion — the primary guess or an alternative. */
export interface ContactLinkCandidate {
  contactId: string;
  displayName: string;
  preferredTone: string;
  confidence: number;
}

// A fuzzy-match "Is this X?" suggestion the bubble banner posed but the user never
// answered — see ContactLinkStore.kt for what writes/clears these. Distinct from
// UnmatchedSender: an unmatched sender has NO guess at all (matched nobody), a pending
// link has a specific guess (and often alternatives) still awaiting yes/no.
export interface PendingContactLink extends ContactLinkCandidate {
  convKey: string;
  senderName: string;
  platform: string | null;
  crossApp?: boolean;
  crossAppSourceLabel?: string;
  candidates: ContactLinkCandidate[];
  updatedAt: number;
}

export async function getPendingContactLinks(): Promise<PendingContactLink[]> {
  try {
    const json: string = await ProTxtSettings?.getPendingContactLinks?.();
    return json ? (JSON.parse(json) as PendingContactLink[]) : [];
  } catch {
    return [];
  }
}

/** "Yes, this is them" — confirms `contactId` (the primary guess or a chosen alternative) for this suggestion. */
export function resolvePendingContactLink(convKey: string, contactId: string): Promise<boolean> {
  return ProTxtSettings?.resolvePendingContactLink?.(convKey, contactId) ?? Promise.resolve(false);
}

/** "Not them" — permanently declines this suggestion; the sender won't be re-suggested. */
export function declinePendingContactLink(convKey: string, senderName: string): Promise<boolean> {
  return ProTxtSettings?.declinePendingContactLink?.(convKey, senderName) ?? Promise.resolve(false);
}
