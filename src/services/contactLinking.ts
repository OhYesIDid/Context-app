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
