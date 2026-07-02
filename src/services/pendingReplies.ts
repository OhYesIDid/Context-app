import { NativeModules } from 'react-native';

const { ProTxtSettings } = NativeModules;

export type ImportanceLevel = 'urgent' | 'elevated' | 'normal';

export interface PendingReply {
  id: string;
  convKey: string;
  contactName: string | null;
  platform: string | null;
  preview: string;
  importance: ImportanceLevel;
  importanceReasons: string[];
  unansweredCount: number;
  createdAt: number;
  updatedAt: number;
}

const IMPORTANCE_ORDER: ImportanceLevel[] = ['urgent', 'elevated', 'normal'];

export async function loadPendingReplies(): Promise<PendingReply[]> {
  try {
    const json: string = await ProTxtSettings.getPendingReplies();
    return JSON.parse(json) as PendingReply[];
  } catch {
    return [];
  }
}

export function clearPendingReply(id: string): void {
  try {
    ProTxtSettings.clearPendingReply(id);
  } catch {}
}

export function openPendingReplyConversation(convKey: string): void {
  try {
    ProTxtSettings.openConversationApp(convKey);
  } catch {}
}

/** Highest importance first, then most recently updated within the same tier. */
export function sortPendingReplies(items: PendingReply[]): PendingReply[] {
  return [...items].sort((a, b) =>
    IMPORTANCE_ORDER.indexOf(a.importance) - IMPORTANCE_ORDER.indexOf(b.importance) ||
    b.updatedAt - a.updatedAt
  );
}

const PLATFORM_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp', telegram: 'Telegram', instagram: 'Instagram',
  messenger: 'Messenger', signal: 'Signal', sms: 'Messages',
};

export function platformLabel(platform: string | null): string | undefined {
  return platform ? (PLATFORM_LABEL[platform] ?? platform) : undefined;
}
