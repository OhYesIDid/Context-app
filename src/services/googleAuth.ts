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
  await GoogleSignin.signOut();
}
