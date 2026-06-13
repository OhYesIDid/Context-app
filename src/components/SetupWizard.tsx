import AsyncStorage from '@react-native-async-storage/async-storage';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  NativeModules,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { configureGoogleSignin, isSignedIn } from '../services/googleAuth';
import { importDeviceContacts } from '../services/deviceContacts';
import { importGoogleContacts } from '../services/googlePeople';
import { pickAndParseWhatsAppExport } from '../services/whatsappParser';

const { ProTxtSettings } = NativeModules;

export interface SetupResult {
  googleAuthed: boolean;
  notifPermission: boolean;
  locationGranted: boolean;
  googleContactsCount: number | null;
  deviceContactsCount: number | null;
  whatsappMessages: number | null;
}

interface Props { onComplete: (result: SetupResult) => void; }

const STEPS = [
  { id: 'welcome',       required: true,  skipLabel: null           }, // 0
  { id: 'nls',           required: true,  skipLabel: null           }, // 1 — hard gate
  { id: 'notif_perm',    required: true,  skipLabel: null           }, // 2 — auto-advances
  { id: 'bubbles',       required: true,  skipLabel: null           }, // 3 — soft gate
  { id: 'accessibility', required: false, skipLabel: 'Skip for now' }, // 4
  { id: 'location',      required: false, skipLabel: 'Skip'         }, // 5
  { id: 'google_cal',    required: false, skipLabel: 'Skip'         }, // 6
  { id: 'contacts',      required: false, skipLabel: 'Skip'         }, // 7
  { id: 'done',          required: true,  skipLabel: null           }, // 8
] as const;

const SETUP_COMPLETE_KEY       = 'setup_complete';
const GOOGLE_CONTACTS_COUNT_KEY = 'setup_google_contacts_count';
const DEVICE_CONTACTS_COUNT_KEY = 'setup_device_contacts_count';
const WHATSAPP_IMPORT_KEY       = 'setup_whatsapp_messages';

export default function SetupWizard({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [nlsConnected, setNlsConnected]                     = useState(false);
  const [hasOpenedNls, setHasOpenedNls]                     = useState(false);
  const [notifPermGranted, setNotifPermGranted]             = useState(false);
  const [bubbleLabel, setBubbleLabel]                       = useState('Notifications → Bubbles');
  const [accessibilityEnabled, setAccessibilityEnabled]     = useState(false);
  const [hasOpenedAccessibility, setHasOpenedAccessibility] = useState(false);
  const [locationGranted, setLocationGranted]               = useState(false);
  const [googleAuthed, setGoogleAuthed]                     = useState(false);
  const [googleContactsCount, setGoogleContactsCount]       = useState<number | null>(null);
  const [deviceContactsCount, setDeviceContactsCount]       = useState<number | null>(null);
  const [whatsappMessages, setWhatsappMessages]             = useState<number | null>(null);
  const [importing, setImporting]                           = useState<'google' | 'device' | 'whatsapp' | null>(null);

  const stepRef = useRef(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  // Mount — configure auth and read initial permission state
  useEffect(() => {
    configureGoogleSignin();
    setGoogleAuthed(isSignedIn());
    if (Platform.OS === 'android' && ProTxtSettings) {
      Promise.all([
        ProTxtSettings.isNlsConnected().catch(() => false),
        ProTxtSettings.isAccessibilityServiceEnabled().catch(() => false),
        ProTxtSettings.getBubbleSettingsLabel().catch(() => 'Notifications → Bubbles'),
      ]).then(([nls, a11y, label]: [boolean, boolean, string]) => {
        setNlsConnected(nls);
        setAccessibilityEnabled(a11y);
        setBubbleLabel(label);
      });
    }
  }, []);

  // Re-check NLS / accessibility when returning from system settings screens
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active' || Platform.OS !== 'android' || !ProTxtSettings) return;
      const s = stepRef.current;
      if (s === 1) {
        const ok: boolean = await ProTxtSettings.isNlsConnected().catch(() => false);
        setNlsConnected(ok);
      }
      if (s === 4) {
        const ok: boolean = await ProTxtSettings.isAccessibilityServiceEnabled().catch(() => false);
        setAccessibilityEnabled(ok);
      }
    });
    return () => sub.remove();
  }, []);

  const advance = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));

  const handleComplete = async () => {
    await AsyncStorage.setItem(SETUP_COMPLETE_KEY, 'true');
    onComplete({ googleAuthed, notifPermission: notifPermGranted, locationGranted, googleContactsCount, deviceContactsCount, whatsappMessages });
  };

  // Step 1 — NLS
  const handleNlsButton = () => {
    if (nlsConnected) { advance(); return; }
    Linking.sendIntent('android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS').catch(() => {});
    setHasOpenedNls(true);
  };

  // Step 2 — notification permission
  const handleNotifPerm = async () => {
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
      ).catch(() => 'denied');
      setNotifPermGranted(result === PermissionsAndroid.RESULTS.GRANTED);
    } else {
      setNotifPermGranted(true);
    }
    advance();
  };

  // Step 4 — accessibility
  const handleAccessibilityButton = () => {
    if (accessibilityEnabled) { advance(); return; }
    ProTxtSettings?.openAccessibilitySettings?.();
    setHasOpenedAccessibility(true);
  };

  // Step 5 — location (fine then background, always advances)
  const handleLocationGrant = async () => {
    try {
      const fine = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        { title: 'Location access', message: 'ProTxt uses your location to estimate your travel time when someone asks where you are.', buttonPositive: 'Allow', buttonNegative: 'Not now' }
      );
      setLocationGranted(fine === PermissionsAndroid.RESULTS.GRANTED);
      if (fine === PermissionsAndroid.RESULTS.GRANTED && Platform.Version >= 29) {
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
          { title: 'Background location', message: 'To estimate your ETA when a message arrives, ProTxt needs location access even when the app is closed. Tap "Allow all the time" on the next screen.', buttonPositive: 'Go to settings', buttonNegative: 'Skip' }
        );
      }
    } catch {}
    advance();
  };

  // Step 6 — Google Calendar sign-in
  const handleGoogleSignIn = async () => {
    if (googleAuthed) { advance(); return; }
    try {
      await GoogleSignin.hasPlayServices();
      await GoogleSignin.signIn();
      setGoogleAuthed(true);
      advance();
    } catch {}
  };

  // Step 7 — contact imports (independent of Continue button)
  const handleImportGoogle = async () => {
    setImporting('google');
    try {
      const count = await importGoogleContacts();
      setGoogleContactsCount(count);
      await AsyncStorage.setItem(GOOGLE_CONTACTS_COUNT_KEY, String(count));
    } catch {}
    setImporting(null);
  };

  const handleImportDevice = async () => {
    setImporting('device');
    try {
      const count = await importDeviceContacts();
      setDeviceContactsCount(count);
      await AsyncStorage.setItem(DEVICE_CONTACTS_COUNT_KEY, String(count));
    } catch {}
    setImporting(null);
  };

  const handleImportWhatsApp = async () => {
    setImporting('whatsapp');
    try {
      const { messageCount } = await pickAndParseWhatsAppExport();
      const newTotal = (whatsappMessages ?? 0) + messageCount;
      setWhatsappMessages(newTotal);
      await AsyncStorage.setItem(WHATSAPP_IMPORT_KEY, String(newTotal));
    } catch (err) {
      if (err instanceof Error && err.message === 'Cancelled') { setImporting(null); return; }
    }
    setImporting(null);
  };

  const currentStep = STEPS[step];
  const isOptional  = currentStep.skipLabel !== null;

  const renderContent = () => {
    switch (step) {
      case 0:
        return (
          <>
            <Text style={s.icon}>💬</Text>
            <Text style={s.stepTitle}>Meet ProTxt</Text>
            <Text style={s.stepDesc}>Smart reply suggestions that appear before you open your messages. Set up takes about a minute.</Text>
          </>
        );
      case 1:
        return (
          <>
            <Text style={s.icon}>🔔</Text>
            <Text style={s.stepTitle}>Allow notification access</Text>
            <Text style={s.stepDesc}>ProTxt reads incoming messages to prepare suggestions. Your messages stay on your device.</Text>
            <View style={[s.pill, nlsConnected ? s.pillGreen : s.pillRed]}>
              <Text style={s.pillText}>{nlsConnected ? '🟢  Enabled' : '🔴  Not enabled'}</Text>
            </View>
          </>
        );
      case 2:
        return (
          <>
            <Text style={s.icon}>📲</Text>
            <Text style={s.stepTitle}>Send you notifications</Text>
            <Text style={s.stepDesc}>Required to deliver reply suggestions as Android notification bubbles.</Text>
          </>
        );
      case 3:
        return (
          <>
            <Text style={s.icon}>💬</Text>
            <Text style={s.stepTitle}>Enable suggestion bubbles</Text>
            <Text style={s.stepDesc}>Open your notification settings and enable Bubbles for ProTxt under {bubbleLabel}.</Text>
          </>
        );
      case 4:
        return (
          <>
            <Text style={s.icon}>♿</Text>
            <Text style={s.stepTitle}>Overlay while you chat</Text>
            <Text style={s.stepDesc}>Enables a suggestion strip above your keyboard — no need to leave the conversation.</Text>
            <View style={[s.pill, accessibilityEnabled ? s.pillGreen : s.pillRed]}>
              <Text style={s.pillText}>{accessibilityEnabled ? '🟢  Enabled' : '🔴  Not enabled'}</Text>
            </View>
          </>
        );
      case 5:
        return (
          <>
            <Text style={s.icon}>📍</Text>
            <Text style={s.stepTitle}>ETA suggestions</Text>
            <Text style={s.stepDesc}>When someone asks where you are, ProTxt can include your estimated arrival time.</Text>
          </>
        );
      case 6:
        return (
          <>
            <Text style={s.icon}>📅</Text>
            <Text style={s.stepTitle}>Availability suggestions</Text>
            <Text style={s.stepDesc}>See your calendar so ProTxt can suggest times when you're free.</Text>
          </>
        );
      case 7:
        return (
          <>
            <Text style={s.icon}>👥</Text>
            <Text style={s.stepTitle}>Import contacts</Text>
            <Text style={s.stepDesc}>Better suggestions come from knowing who you're talking to.</Text>
            <View style={s.importRows}>
              <ImportRow
                label="Google Contacts"
                status={googleContactsCount !== null ? `${googleContactsCount} imported ✓` : undefined}
                loading={importing === 'google'}
                disabled={!googleAuthed}
                disabledHint="Sign in with Google first"
                onPress={handleImportGoogle}
              />
              <ImportRow
                label="Device Contacts"
                status={deviceContactsCount !== null ? `${deviceContactsCount} imported ✓` : undefined}
                loading={importing === 'device'}
                onPress={handleImportDevice}
              />
              <ImportRow
                label="WhatsApp History"
                status={whatsappMessages !== null ? `${whatsappMessages} messages ✓` : undefined}
                loading={importing === 'whatsapp'}
                onPress={handleImportWhatsApp}
              />
            </View>
          </>
        );
      case 8:
        return (
          <>
            <Text style={s.icon}>✅</Text>
            <Text style={s.stepTitle}>You're all set!</Text>
            <Text style={s.stepDesc}>ProTxt runs in the background. Suggestions will appear when messages arrive.</Text>
          </>
        );
      default:
        return null;
    }
  };

  const renderPrimaryButton = () => {
    switch (step) {
      case 0: return <WizardBtn label="Get started" onPress={advance} />;
      case 1: return (
        <WizardBtn
          label={nlsConnected ? 'Enabled ✓  —  Continue' : 'Open Notification Settings'}
          disabled={!nlsConnected && hasOpenedNls}
          onPress={handleNlsButton}
        />
      );
      case 2: return <WizardBtn label="Grant permission" onPress={handleNotifPerm} />;
      case 3: return <WizardBtn label="Done" onPress={advance} />;
      case 4: return (
        <WizardBtn
          label={accessibilityEnabled ? 'Enabled ✓  —  Continue' : 'Open Accessibility Settings'}
          disabled={!accessibilityEnabled && hasOpenedAccessibility}
          onPress={handleAccessibilityButton}
        />
      );
      case 5: return <WizardBtn label="Grant location" onPress={handleLocationGrant} />;
      case 6: return (
        <WizardBtn
          label={googleAuthed ? 'Connected ✓  —  Continue' : 'Sign in with Google'}
          onPress={handleGoogleSignIn}
        />
      );
      case 7: return <WizardBtn label="Continue" onPress={advance} />;
      case 8: return <WizardBtn label="Start using ProTxt" onPress={handleComplete} />;
      default: return null;
    }
  };

  return (
    <SafeAreaView style={s.safe}>
      {isOptional && (
        <Pressable style={s.skipBtn} onPress={() => setStep((prev) => prev + 1)}>
          <Text style={s.skipText}>{currentStep.skipLabel}</Text>
        </Pressable>
      )}
      <View style={s.content}>
        {renderContent()}
      </View>
      <View style={s.footer}>
        {renderPrimaryButton()}
        <View style={s.dots}>
          {STEPS.map((_, i) => (
            <View key={i} style={[s.dot, i === step && s.dotActive]} />
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function WizardBtn({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable style={[s.primaryBtn, disabled && s.primaryBtnDisabled]} onPress={onPress} disabled={disabled}>
      <Text style={s.primaryBtnText}>{label}</Text>
    </Pressable>
  );
}

function ImportRow({
  label, status, loading, disabled = false, disabledHint, onPress,
}: {
  label: string;
  status?: string;
  loading: boolean;
  disabled?: boolean;
  disabledHint?: string;
  onPress: () => void;
}) {
  return (
    <View style={s.importRow}>
      <View style={s.importLeft}>
        <Text style={s.importLabel}>{label}</Text>
        {status
          ? <Text style={s.importStatus}>{status}</Text>
          : disabled && disabledHint
            ? <Text style={s.importHint}>{disabledHint}</Text>
            : null}
      </View>
      <Pressable style={[s.importBtn, (disabled || loading) && s.importBtnDisabled]} onPress={onPress} disabled={disabled || loading}>
        {loading
          ? <ActivityIndicator size="small" color={PURPLE} />
          : <Text style={[s.importBtnText, disabled && s.importBtnTextDisabled]}>{status ? 'Update' : 'Import'}</Text>}
      </Pressable>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const BG     = '#0c0c0e';
const SURFACE = '#18181b';
const BORDER  = '#27272a';
const TEXT    = '#f4f4f5';
const MUTED   = '#71717a';
const PURPLE  = '#6366f1';
const GREEN   = '#4ade80';
const RED     = '#f87171';

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },

  skipBtn: { position: 'absolute', top: 56, right: 24, zIndex: 10, padding: 8 },
  skipText: { color: MUTED, fontSize: 15 },

  content: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },

  icon:      { fontSize: 52, marginBottom: 24 },
  stepTitle: { fontSize: 26, fontWeight: '700', color: TEXT, textAlign: 'center', marginBottom: 14, letterSpacing: -0.4 },
  stepDesc:  { fontSize: 16, color: MUTED, textAlign: 'center', lineHeight: 24 },

  pill:      { marginTop: 24, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 20, borderWidth: 1 },
  pillGreen: { backgroundColor: GREEN + '22', borderColor: GREEN + '55' },
  pillRed:   { backgroundColor: RED + '22',   borderColor: RED + '55'   },
  pillText:  { fontSize: 14, fontWeight: '500', color: TEXT },

  importRows: { width: '100%', marginTop: 28 },
  importRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: BORDER },
  importLeft: { flex: 1, marginRight: 12 },
  importLabel: { fontSize: 15, color: TEXT, fontWeight: '500' },
  importStatus: { fontSize: 12, color: GREEN, marginTop: 3 },
  importHint:   { fontSize: 12, color: MUTED, marginTop: 3 },
  importBtn:    { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8, backgroundColor: PURPLE + '22', borderWidth: 1, borderColor: PURPLE + '55', minWidth: 70, alignItems: 'center' },
  importBtnDisabled: { opacity: 0.35 },
  importBtnText: { fontSize: 14, color: PURPLE, fontWeight: '600' },
  importBtnTextDisabled: { color: MUTED },

  footer:     { paddingHorizontal: 24, paddingBottom: 36 },
  primaryBtn: { backgroundColor: PURPLE, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 28 },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  dots:    { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  dot:     { width: 6, height: 6, borderRadius: 3, backgroundColor: BORDER },
  dotActive: { backgroundColor: PURPLE, width: 20 },
});
