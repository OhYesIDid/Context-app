import { NativeModules } from 'react-native';
import { digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';

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
    // Genuine decrypt failure (e.g. the on-device AES key changed since this
    // row was encrypted) — never return the raw ciphertext. Callers commonly
    // do `(await decryptField(x)) ?? x`, which would fall back to the raw
    // (still-encrypted) column value if this returned null; '' isn't nullish
    // so that fallback doesn't kick in and the enc1:... blob never reaches the UI.
    return '';
  }
}

// HMAC-SHA256 of (platform + ":" + identifier) using the Keystore-backed db key.
// Stored alongside the encrypted identifier so equality lookups don't need decryption.
// Falls back to a plain SHA-256 digest if the native bridge is unavailable.
export async function hashIdentifier(platform: string, identifier: string): Promise<string> {
  const input = `${platform}:${identifier}`;
  try {
    return await ProTxtSettings.hmacIdentifier(input);
  } catch {
    return digestStringAsync(CryptoDigestAlgorithm.SHA256, input);
  }
}
