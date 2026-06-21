import { NativeModules } from 'react-native';

// AES-256-GCM field-level encryption for SQLite.
// Encryption runs on the Kotlin side (javax.crypto.Cipher) so it works in any
// Hermes version. Key is generated once by SecureRandom and stored in
// EncryptedSharedPreferences (Android Keystore-backed) via ProTxtSettingsModule.

const { ProTxtSettings } = NativeModules;
const PREFIX = 'enc1:';

export async function encryptField(value: string | null | undefined): Promise<string | null> {
  if (value == null || value === '') return value ?? null;
  if (value.startsWith(PREFIX)) return value; // already encrypted
  try {
    return await ProTxtSettings.encryptText(value);
  } catch {
    return value; // native unavailable — store plaintext rather than crash
  }
}

export async function decryptField(value: string | null | undefined): Promise<string | null> {
  if (value == null) return null;
  if (!value.startsWith(PREFIX)) return value; // legacy plaintext passthrough
  try {
    return await ProTxtSettings.decryptText(value);
  } catch {
    return value;
  }
}
