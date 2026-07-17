import { NativeModules } from 'react-native';

// Thin bridge to ProTxtSettingsModule.logEvent (Kotlin) -> Firebase Analytics.
// Best-effort only — analytics must never be able to break app flow.
const { ProTxtSettings } = NativeModules;

export function logEvent(name: string, params: Record<string, string> = {}): void {
  try {
    ProTxtSettings?.logEvent(name, params);
  } catch {
    // ignore
  }
}
