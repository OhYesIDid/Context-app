import { GoogleSignin } from '@react-native-google-signin/google-signin';

export function configureGoogleSignin(): void {
  GoogleSignin.configure({
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_OAUTH_WEB_CLIENT_ID,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    offlineAccess: false,
  });
}

// No-op: native SDK handles token persistence across app restarts.
export async function initAuth(): Promise<void> {}

export async function getAccessToken(): Promise<string> {
  try {
    const { accessToken } = await GoogleSignin.getTokens();
    if (!accessToken) throw new Error('No access token returned');
    return accessToken;
  } catch {
    throw new Error('Not signed in to Google. Please sign in first.');
  }
}

export function isSignedIn(): boolean {
  return GoogleSignin.getCurrentUser() !== null;
}

export async function signOut(): Promise<void> {
  await GoogleSignin.signOut();
}
