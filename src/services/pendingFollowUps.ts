import { NativeModules } from 'react-native';

const { ProTxtSettings } = NativeModules;

export interface PendingFollowUp {
  id: string;
  task: string;
  dueHint: string | null;
  contactName: string | null;
  convKey: string;
  createdAt: number;
}

export async function loadPendingFollowUps(): Promise<PendingFollowUp[]> {
  try {
    const json: string = await ProTxtSettings.getPendingFollowUps();
    return JSON.parse(json) as PendingFollowUp[];
  } catch {
    return [];
  }
}

export function clearPendingFollowUp(id: string): void {
  try { ProTxtSettings.clearPendingFollowUp(id); } catch {}
}

export interface ConfirmedFollowUp {
  id: string;
  task: string;
  contactName: string | null;
  dueHint: string | null;
  createdAt: number;
}

export async function drainConfirmedFollowUps(): Promise<ConfirmedFollowUp[]> {
  try {
    const json: string = await ProTxtSettings.drainConfirmedFollowUps();
    return JSON.parse(json) as ConfirmedFollowUp[];
  } catch {
    return [];
  }
}
