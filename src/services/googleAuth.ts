import { GoogleSignin } from '@react-native-google-signin/google-signin';

export function configureGoogleSignin(): void {
  GoogleSignin.configure({
    webClientId: '790415280323-n2r8vkcl16qvodepibg29khhv1mq1816.apps.googleusercontent.com',
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/contacts.readonly',
    ],
    offlineAccess: false,
  });
}

// No-op: native SDK handles token persistence across app restarts.
export async function initAuth(): Promise<void> {}

// Google access tokens expire after 60 min. Refresh proactively at 45 min so
// we don't hand an expired token to Calendar / Maps mid-request.
const TOKEN_TTL_MS = 45 * 60 * 1000;
let lastFetchAt = 0;
let lastToken: string | null = null;

export async function getAccessToken(): Promise<string> {
  try {
    const now = Date.now();
    const stale = now - lastFetchAt >= TOKEN_TTL_MS;
    // clearCachedAccessToken evicts the Android OAuth2 cache entry so the next
    // getTokens() call is forced to hit Google for a fresh token. No-op on iOS
    // (the iOS SDK auto-refreshes internally).
    if (stale && lastToken) {
      await GoogleSignin.clearCachedAccessToken(lastToken);
      lastToken = null;
    }
    const { accessToken } = await GoogleSignin.getTokens();
    if (!accessToken) throw new Error('No access token returned');
    lastToken = accessToken;
    lastFetchAt = now;
    return accessToken;
  } catch {
    throw new Error('Not signed in to Google. Please sign in first.');
  }
}

// Call when a Google API returns HTTP 401 to force a fresh token on the next call.
export function invalidateToken(): void {
  lastFetchAt = 0;
}

export function isSignedIn(): boolean {
  return GoogleSignin.getCurrentUser() !== null;
}

// The native SDK persists granted scopes across app restarts (and process
// kills) at the account level — this lets us restore `gmailConnected` on
// launch instead of relying on the one-time "Connect" button tap, which only
// ever set an in-memory flag that reset to false every time Android killed
// the app.
export function hasGmailScope(): boolean {
  return GoogleSignin.getCurrentUser()?.scopes?.includes('https://www.googleapis.com/auth/gmail.readonly') ?? false;
}

export async function requestGmailScope(): Promise<boolean> {
  try {
    const result = await GoogleSignin.addScopes({
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });
    return result !== null;
  } catch {
    return false;
  }
}

export async function signOut(): Promise<void> {
  lastFetchAt = 0;
  lastToken = null;
  await GoogleSignin.signOut();
}
