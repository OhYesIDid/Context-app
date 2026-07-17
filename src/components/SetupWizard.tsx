import AsyncStorage from '@react-native-async-storage/async-storage';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Modal,
  NativeModules,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { configureGoogleSignin, isSignedIn } from '../services/googleAuth';
import { importDeviceContacts } from '../services/deviceContacts';
import { importGoogleContacts } from '../services/googlePeople';
import { refreshContactListCache } from '../services/styleSync';
import { pickAndParseWhatsAppExport } from '../services/whatsappParser';

const { ProTxtSettings: ConTxtSettings } = NativeModules;

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
  { id: 'location',      required: false, skipLabel: 'Skip'         }, // 4
  { id: 'google_cal',    required: false, skipLabel: 'Skip'         }, // 5
  { id: 'contacts',      required: false, skipLabel: 'Skip'         }, // 6
  { id: 'done',          required: true,  skipLabel: null           }, // 7
] as const;

const SETUP_COMPLETE_KEY       = 'setup_complete';
const SETUP_STEP_KEY           = 'setup_step';
const GOOGLE_CONTACTS_COUNT_KEY = 'setup_google_contacts_count';
const DEVICE_CONTACTS_COUNT_KEY = 'setup_device_contacts_count';
const WHATSAPP_IMPORT_KEY       = 'setup_whatsapp_messages';

export default function SetupWizard({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [nlsConnected, setNlsConnected]                     = useState(false);
  const [hasOpenedNls, setHasOpenedNls]                     = useState(false);
  const [notifPermGranted, setNotifPermGranted]             = useState(false);
  const [bubbleLabel, setBubbleLabel]                       = useState('Notifications → Bubbles');
  const [hasOpenedBubbles, setHasOpenedBubbles]             = useState(false);
  const [locationGranted, setLocationGranted]               = useState(false);
  const [googleAuthed, setGoogleAuthed]                     = useState(false);
  const [googleContactsCount, setGoogleContactsCount]       = useState<number | null>(null);
  const [deviceContactsCount, setDeviceContactsCount]       = useState<number | null>(null);
  const [whatsappMessages, setWhatsappMessages]             = useState<number | null>(null);
  const [importing, setImporting]                           = useState<'google' | 'device' | 'whatsapp' | null>(null);
  const [importProgress, setImportProgress]                 = useState<{ current: number; total: number; label: string } | null>(null);

  // Tracks whether the progress modal should receive updates.
  // Set to false when user dismisses to background — import keeps running silently.
  const showProgressRef = useRef(false);

  const runInBackground = () => {
    showProgressRef.current = false;
    setImportProgress(null);
    setImporting(null);
  };

  const stepRef = useRef(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  const hasOpenedBubblesRef = useRef(hasOpenedBubbles);
  useEffect(() => { hasOpenedBubblesRef.current = hasOpenedBubbles; }, [hasOpenedBubbles]);

  // Restore step and contact counts on re-open mid-setup
  useEffect(() => {
    AsyncStorage.multiGet([SETUP_STEP_KEY, GOOGLE_CONTACTS_COUNT_KEY, DEVICE_CONTACTS_COUNT_KEY, WHATSAPP_IMPORT_KEY])
      .then((pairs) => {
        const map = Object.fromEntries(pairs.map(([k, v]) => [k, v]));
        const saved = Number(map[SETUP_STEP_KEY]);
        if (saved > 0 && saved < STEPS.length - 1) setStep(saved);
        const gc = map[GOOGLE_CONTACTS_COUNT_KEY]; if (gc) setGoogleContactsCount(Number(gc));
        const dc = map[DEVICE_CONTACTS_COUNT_KEY]; if (dc) setDeviceContactsCount(Number(dc));
        const wa = map[WHATSAPP_IMPORT_KEY];        if (wa) setWhatsappMessages(Number(wa));
      }).catch(() => {});
  }, []);

  // Mount — configure auth and read initial permission state
  useEffect(() => {
    configureGoogleSignin();
    setGoogleAuthed(isSignedIn());
    if (Platform.OS === 'android' && ConTxtSettings) {
      Promise.all([
        ConTxtSettings.isNlsConnected().catch(() => false),
        ConTxtSettings.getBubbleSettingsLabel().catch(() => 'Notifications → Bubbles'),
      ]).then(([nls, label]: [boolean, string]) => {
        setNlsConnected(nls);
        setBubbleLabel(label);
      });
    }
  }, []);

  // Re-check NLS when returning from system settings screens
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active' || Platform.OS !== 'android' || !ConTxtSettings) return;
      const s = stepRef.current;
      if (s === 1) {
        const ok: boolean = await ConTxtSettings.isNlsConnected().catch(() => false);
        setNlsConnected(ok);
        if (ok) advance();
      }
      if (s === 3 && hasOpenedBubblesRef.current) {
        advance();
      }
    });
    return () => sub.remove();
  }, []);

  const advance = () => setStep((s) => {
    const next = Math.min(s + 1, STEPS.length - 1);
    AsyncStorage.setItem(SETUP_STEP_KEY, String(next)).catch(() => {});
    return next;
  });

  const handleComplete = () => {
    AsyncStorage.multiSet([[SETUP_COMPLETE_KEY, 'true'], [SETUP_STEP_KEY, '']]).catch(() => {});
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

  // Step 3 — bubbles
  const handleBubblesButton = () => {
    if (hasOpenedBubbles) { advance(); return; }
    ConTxtSettings?.openNotificationSettings?.();
    setHasOpenedBubbles(true);
  };

  // Step 4 — location (fine then background, always advances)
  const handleLocationGrant = async () => {
    try {
      const fine = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        { title: 'Location access', message: 'ConTxt uses your location to estimate your travel time when someone asks where you are.', buttonPositive: 'Allow', buttonNegative: 'Not now' }
      );
      setLocationGranted(fine === PermissionsAndroid.RESULTS.GRANTED);
      if (fine === PermissionsAndroid.RESULTS.GRANTED && Platform.Version >= 29) {
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
          { title: 'Background location', message: 'To estimate your ETA when a message arrives, ConTxt needs location access even when the app is closed. Tap "Allow all the time" on the next screen.', buttonPositive: 'Go to settings', buttonNegative: 'Skip' }
        );
      }
    } catch {}
    advance();
  };

  // Step 6 — Google Calendar sign-in
  const handleGoogleSignIn = async () => {
    if (googleAuthed) { advance(); return; }
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const result = await GoogleSignin.signIn();
      if (result.type === 'success') {
        setGoogleAuthed(true);
        advance();
      }
      // type === 'cancelled': user dismissed account picker or consent — stay on step
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      Alert.alert('Sign-in error', msg);
    }
  };

  // Step 7 — contact imports (independent of Continue button)
  const handleImportGoogle = async () => {
    showProgressRef.current = true;
    setImporting('google');
    setImportProgress({ current: 0, total: 0, label: 'Importing Google Contacts…' });
    await new Promise<void>((r) => setTimeout(r, 80));
    try {
      const count = await importGoogleContacts((current) => {
        if (showProgressRef.current) {
          setImportProgress({ current, total: 0, label: 'Importing Google Contacts…' });
        }
      });
      setGoogleContactsCount(count);
      await AsyncStorage.setItem(GOOGLE_CONTACTS_COUNT_KEY, String(count));
      refreshContactListCache().catch(() => {});
    } catch {}
    if (showProgressRef.current) {
      setImportProgress(null);
      setImporting(null);
    }
  };

  const handleImportDevice = async () => {
    showProgressRef.current = true;
    setImporting('device');
    setImportProgress({ current: 0, total: 0, label: 'Importing device contacts…' });
    await new Promise<void>((r) => setTimeout(r, 80));
    try {
      const count = await importDeviceContacts((current, total) => {
        if (showProgressRef.current) {
          setImportProgress({ current, total, label: 'Importing device contacts…' });
        }
      });
      setDeviceContactsCount(count);
      await AsyncStorage.setItem(DEVICE_CONTACTS_COUNT_KEY, String(count));
      refreshContactListCache().catch(() => {});
    } catch {}
    if (showProgressRef.current) {
      setImportProgress(null);
      setImporting(null);
    }
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
            <Text style={s.stepTitle}>Meet ConTxt</Text>
            <Text style={s.stepDesc}>Smart reply suggestions that appear before you open your messages. Set up takes about a minute.</Text>
          </>
        );
      case 1:
        return (
          <>
            <Text style={s.icon}>🔔</Text>
            <Text style={s.stepTitle}>Allow notification access</Text>
            <Text style={s.stepDesc}>ConTxt reads incoming messages to prepare suggestions. Your messages stay on your device.</Text>
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
            <Text style={s.stepDesc}>Tap below to open notification settings, then enable Bubbles for ConTxt under {bubbleLabel}.</Text>
          </>
        );
      case 4:
        return (
          <>
            <Text style={s.icon}>📍</Text>
            <Text style={s.stepTitle}>ETA suggestions</Text>
            <Text style={s.stepDesc}>When someone asks where you are, ConTxt can include your estimated arrival time.</Text>
          </>
        );
      case 5:
        return (
          <>
            <Text style={s.icon}>📅</Text>
            <Text style={s.stepTitle}>Availability suggestions</Text>
            <Text style={s.stepDesc}>See your calendar so ConTxt can suggest times when you're free.</Text>
          </>
        );
      case 6:
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
      case 7:
        return (
          <>
            <Text style={s.icon}>✅</Text>
            <Text style={s.stepTitle}>You're all set!</Text>
            <Text style={s.stepDesc}>ConTxt runs in the background. Suggestions appear when someone asks about your ETA, availability, or plans — when your context makes a real difference.</Text>
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
      case 3: return (
        <WizardBtn
          label={hasOpenedBubbles ? 'Done  —  Continue' : 'Open Notification Settings'}
          onPress={handleBubblesButton}
        />
      );
      case 4: return <WizardBtn label="Grant location" onPress={handleLocationGrant} />;
      case 5: return (
        <WizardBtn
          label={googleAuthed ? 'Connected ✓  —  Continue' : 'Sign in with Google'}
          onPress={handleGoogleSignIn}
        />
      );
      case 6: return <WizardBtn label="Continue" onPress={advance} />;
      case 7: return <WizardBtn label="Start using ConTxt" onPress={handleComplete} />;
      default: return null;
    }
  };

  return (
    <SafeAreaView style={s.safe}>
      <Modal transparent animationType="fade" visible={importProgress !== null}>
        <View style={s.progressOverlay}>
          <View style={s.progressCard}>
            <Text style={s.progressLabel}>{importProgress?.label ?? ''}</Text>
            {importProgress && importProgress.total > 0 ? (
              <>
                <View style={s.progressTrack}>
                  <View style={[s.progressFill, { width: `${Math.round((importProgress.current / importProgress.total) * 100)}%` as any }]} />
                </View>
                <Text style={s.progressCount}>{importProgress.current} of {importProgress.total}</Text>
              </>
            ) : (
              <>
                <ActivityIndicator color="#6366f1" style={{ marginVertical: 8 }} />
                {(importProgress?.current ?? 0) > 0 && (
                  <Text style={s.progressCount}>{importProgress!.current} imported so far…</Text>
                )}
              </>
            )}
            {(importProgress?.current ?? 0) > 0 && (
              <Pressable onPress={runInBackground} style={s.bgBtn}>
                <Text style={s.bgBtnText}>Continue in background</Text>
              </Pressable>
            )}
          </View>
        </View>
      </Modal>
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

  progressOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  progressCard: { backgroundColor: '#fff', borderRadius: 16, padding: 28, width: 280, alignItems: 'center' },
  progressLabel: { fontSize: 15, fontWeight: '600', color: '#1e1b4b', marginBottom: 16, textAlign: 'center' },
  progressTrack: { width: '100%', height: 6, backgroundColor: '#e0e7ff', borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: 6, backgroundColor: '#6366f1', borderRadius: 3 },
  progressCount: { fontSize: 13, color: '#6b7280', marginTop: 10 },
  bgBtn: { marginTop: 20, paddingVertical: 8, paddingHorizontal: 16 },
  bgBtnText: { fontSize: 13, color: '#6366f1', fontWeight: '500' },

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
