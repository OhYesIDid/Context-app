import { NativeModules } from 'react-native';
import { getRandomBytesAsync } from 'expo-crypto';

// AES-256-GCM field-level encryption for SQLite using the Web Crypto API.
// crypto.subtle is available in Hermes via RN New Architecture (0.76+) but only when
// the JSI is fully initialised. We guard every call and fall back to plaintext if
// the API is missing so a startup crash never blocks the DB.

const { ProTxtSettings } = NativeModules;
const ALGO = 'AES-GCM';
const PREFIX = 'enc1:';

function subtleAvailable(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    crypto.subtle != null &&
    typeof crypto.subtle.importKey === 'function'
  );
}

let _key: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey | null> {
  if (!subtleAvailable()) return null;
  if (_key) return _key;
  try {
    const b64: string = await ProTxtSettings.getOrCreateDbKey();
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    _key = await crypto.subtle.importKey('raw', raw, { name: ALGO, length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    return _key;
  } catch {
    return null;
  }
}

export async function encryptField(value: string | null | undefined): Promise<string | null> {
  if (value == null || value === '') return value ?? null;
  if (value.startsWith(PREFIX)) return value;
  const key = await getKey();
  if (!key) return value; // crypto unavailable — store plaintext
  try {
    const iv = await getRandomBytesAsync(12);
    const ct = await crypto.subtle.encrypt({ name: ALGO, iv }, key, new TextEncoder().encode(value));
    const ivB64 = btoa(String.fromCharCode(...iv));
    const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ct)));
    return `${PREFIX}${ivB64}:${ctB64}`;
  } catch {
    return value;
  }
}

export async function decryptField(value: string | null | undefined): Promise<string | null> {
  if (value == null) return null;
  if (!value.startsWith(PREFIX)) return value; // plaintext passthrough
  const key = await getKey();
  if (!key) return value; // can't decrypt without subtle
  try {
    const rest = value.slice(PREFIX.length);
    const sep = rest.indexOf(':');
    const iv = Uint8Array.from(atob(rest.slice(0, sep)), (c) => c.charCodeAt(0));
    const ct = Uint8Array.from(atob(rest.slice(sep + 1)), (c) => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return value;
  }
}
