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

// decryptField() returns '' — not null — specifically so callers' common
// `(await decryptField(x)) ?? x` idiom can't fall back to the raw enc1:... ciphertext
// on a genuine decrypt failure. But '' isn't nullish either, so that idiom actually
// just silently keeps the ''  — fine for fields nobody shows raw, wrong for anything
// displayed directly (a name, a handle, a memory bullet), where a blank row reads as
// broken/missing rather than "this couldn't be decrypted". These wrap the check once
// instead of hand-rolling `decrypted === '' && raw ? ... : ...` at every call site.

// For fields shown directly to the user where blank would look broken — falls back to
// a visible placeholder instead of an empty string on genuine decrypt failure.
export async function decryptFieldOrPlaceholder(
  value: string | null | undefined,
  placeholder: string
): Promise<string> {
  const decrypted = await decryptField(value);
  if (decrypted === '' && value) return placeholder; // '' + a raw value present = failure, not "genuinely blank"
  return decrypted ?? value ?? '';
}

// For optional fields (e.g. notes) where omitting the value on failure is the right
// UX — the field's own "empty" rendering already handles it gracefully.
export async function decryptFieldOrUndefined(value: string | null | undefined): Promise<string | undefined> {
  const decrypted = await decryptField(value);
  if (decrypted === '' && value) return undefined;
  return decrypted ?? undefined;
}

// For required-string fields that are never shown raw to the user (e.g. style-edit
// text feeding tone-learning prompts) — '' on failure is already correct (downstream
// consumers filter empty entries), this just replaces the misleading `?? raw` idiom
// that reads as if it falls back to the ciphertext, when decryptField's own '' return
// means it never actually does.
export async function decryptFieldSafe(value: string): Promise<string> {
  return (await decryptField(value)) ?? '';
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
