import AsyncStorage from '@react-native-async-storage/async-storage';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

// Lazy-load the Android-only native module to avoid a startup crash.
type NotificationPayload = { bigText?: string; text?: string };
const NotificationListener = Platform.OS === 'android'
  ? (() => { try { return require('expo-android-notification-listener-service').default; } catch { return null; } })()
  : null;

import { suggestReply } from './src/services/claude';
import { importDeviceContacts } from './src/services/deviceContacts';
import { configureGoogleSignin, initAuth, isSignedIn, signOut } from './src/services/googleAuth';
import { getAvailabilityData } from './src/services/googleCalendar';
import { getEtaData } from './src/services/googleMaps';
import { importGoogleContacts } from './src/services/googlePeople';
import { pickAndParseWhatsAppExport } from './src/services/whatsappParser';
import type { Intent, ReplyOptions, SuggestReplyInput, Tone } from './src/types';
import { detectIntent } from './src/utils/intentDetector';

const INTENT_LABEL: Record<Intent, string> = {
  eta: '📍 ETA request',
  availability: '📅 Availability request',
  other: '💬 General message',
};

const TONE_LABEL: Record<Tone, string> = {
  formal: 'Formal',
  casual: 'Casual',
  brief: 'Brief',
};

const TONE_COLOR: Record<Tone, string> = {
  formal: '#6366f1',
  casual: '#10b981',
  brief: '#f59e0b',
};

function SetupRow({
  label, status, done, loading, onPress,
}: { label: string; status: string; done: boolean; loading: boolean; onPress: () => void }) {
  return (
    <Pressable style={styles.settingRow} onPress={onPress} disabled={loading}>
      <View style={styles.settingLeft}>
        <Text style={[styles.setupDot, done && styles.setupDotDone]}>{done ? '✓' : '·'}</Text>
        <View>
          <Text style={styles.settingText}>{label}</Text>
          <Text style={styles.setupStatus}>{loading ? 'Importing…' : status}</Text>
        </View>
      </View>
      {!loading && <Text style={styles.setupAction}>{done ? 'Update' : 'Import'}</Text>}
    </Pressable>
  );
}

const DEFAULT_TONE_KEY = 'default_tone';
const GOOGLE_CONTACTS_COUNT_KEY = 'setup_google_contacts_count';
const DEVICE_CONTACTS_COUNT_KEY = 'setup_device_contacts_count';
const WHATSAPP_IMPORT_KEY = 'setup_whatsapp_messages';

export default function App() {
  const [message, setMessage] = useState('');
  const [replies, setReplies] = useState<ReplyOptions | null>(null);
  const [tone, setTone] = useState<Tone>('casual');
  const [defaultTone, setDefaultToneState] = useState<Tone>('casual');
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [intent, setIntent] = useState<Intent | null>(null);
  const [contextSummary, setContextSummary] = useState('');
  const [copied, setCopied] = useState(false);
  const [googleAuthed, setGoogleAuthed] = useState(false);
  const [notifPermission, setNotifPermission] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [googleContactsCount, setGoogleContactsCount] = useState<number | null>(null);
  const [deviceContactsCount, setDeviceContactsCount] = useState<number | null>(null);
  const [whatsappMessages, setWhatsappMessages] = useState<number | null>(null);
  const [setupLoading, setSetupLoading] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset copied indicator when switching tones
  useEffect(() => { setCopied(false); }, [tone]);

  // Load settings + configure auth on mount
  useEffect(() => {
    AsyncStorage.multiGet([
      DEFAULT_TONE_KEY,
      GOOGLE_CONTACTS_COUNT_KEY,
      DEVICE_CONTACTS_COUNT_KEY,
      WHATSAPP_IMPORT_KEY,
    ]).then((pairs) => {
      const map = Object.fromEntries(pairs.map(([k, v]) => [k, v]));
      const saved = map[DEFAULT_TONE_KEY];
      if (saved === 'formal' || saved === 'casual' || saved === 'brief') {
        setDefaultToneState(saved); setTone(saved);
      }
      const gc = map[GOOGLE_CONTACTS_COUNT_KEY];
      if (gc !== null) setGoogleContactsCount(Number(gc));
      const dc = map[DEVICE_CONTACTS_COUNT_KEY];
      if (dc !== null) setDeviceContactsCount(Number(dc));
      const wa = map[WHATSAPP_IMPORT_KEY];
      if (wa !== null) setWhatsappMessages(Number(wa));
    });
    configureGoogleSignin();
    initAuth().then(() => setGoogleAuthed(isSignedIn()));
    // Android 13+ requires runtime grant for posting notifications
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => {});
    }
  }, []);

  // Android notification listener setup
  useEffect(() => {
    if (!NotificationListener) return;
    try {
      const granted = NotificationListener.isNotificationPermissionGranted();
      setNotifPermission(granted);
      if (granted) {
        NotificationListener.setAllowedPackages([
          'com.whatsapp', 'com.whatsapp.w4b', 'org.telegram.messenger',
          'com.facebook.orca', 'org.thoughtcrime.securesms',
          'com.google.android.apps.messaging', 'com.instagram.android',
        ]);
      }
    } catch {}
    let subscription: { remove: () => void } | null = null;
    try {
      subscription = NotificationListener.addListener(
        'onNotificationReceived',
        (notification: NotificationPayload) => {
          const text = notification.bigText || notification.text;
          if (text) { setMessage(text); setReplies(null); setIntent(null); setContextSummary(''); }
        }
      );
    } catch {}
    return () => subscription?.remove();
  }, []);

  // iOS notification reply action setup
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    import('expo-notifications').then((Notifications) => {
      (async () => {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status !== 'granted') return;
        await Notifications.setNotificationCategoryAsync('incoming_message', [{
          identifier: 'SUGGEST_REPLY',
          buttonTitle: 'Suggest Reply',
          textInput: { submitButtonTitle: 'Send', placeholder: 'Reply…' },
        }]);
      })();
      const sub = Notifications.addNotificationResponseReceivedListener((response) => {
        if (response.actionIdentifier !== 'SUGGEST_REPLY') return;
        const incoming = (response.notification.request.content.body ?? '').trim();
        if (incoming) { setMessage(incoming); setReplies(null); setIntent(null); setContextSummary(''); }
      });
      return () => sub.remove();
    });
  }, []);

  useEffect(() => {
    return () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); };
  }, []);

  const saveDefaultTone = async (t: Tone) => {
    setDefaultToneState(t);
    setTone(t);
    await AsyncStorage.setItem(DEFAULT_TONE_KEY, t);
  };

  const handleImportGoogleContacts = async () => {
    if (!googleAuthed) { Alert.alert('Not signed in', 'Please sign in with Google first.'); return; }
    setSetupLoading('google');
    try {
      const count = await importGoogleContacts();
      setGoogleContactsCount(count);
      await AsyncStorage.setItem(GOOGLE_CONTACTS_COUNT_KEY, String(count));
      Alert.alert('Done', `Imported ${count} Google contacts.`);
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Import failed');
    } finally { setSetupLoading(null); }
  };

  const handleImportDeviceContacts = async () => {
    setSetupLoading('device');
    try {
      const count = await importDeviceContacts();
      setDeviceContactsCount(count);
      await AsyncStorage.setItem(DEVICE_CONTACTS_COUNT_KEY, String(count));
      Alert.alert('Done', `Imported ${count} device contacts.`);
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Import failed');
    } finally { setSetupLoading(null); }
  };

  const handleImportWhatsApp = async () => {
    setSetupLoading('whatsapp');
    try {
      const { contactName, messageCount } = await pickAndParseWhatsAppExport();
      const newTotal = (whatsappMessages ?? 0) + messageCount;
      setWhatsappMessages(newTotal);
      await AsyncStorage.setItem(WHATSAPP_IMPORT_KEY, String(newTotal));
      Alert.alert('Done', `Imported ${messageCount} messages from chat with ${contactName}. Total: ${newTotal}.`);
    } catch (err) {
      if (err instanceof Error && err.message === 'Cancelled') { setSetupLoading(null); return; }
      Alert.alert('Error', err instanceof Error ? err.message : 'Import failed');
    } finally { setSetupLoading(null); }
  };

  const handleSuggest = async () => {
    if (!message.trim()) return;
    setLoading(true);
    setReplies(null);
    setContextSummary('');
    setCopied(false);
    try {
      const detected = detectIntent(message);
      setIntent(detected);
      const input: SuggestReplyInput = { originalMessage: message, intent: detected };

      if (detected === 'eta') {
        setStatusText('Fetching journey time…');
        const etaData = await getEtaData();
        input.etaData = etaData;
        setContextSummary(`${etaData.duration} to ${etaData.destinationLabel} · ${etaData.distance} via ${etaData.routeSummary}`);
      } else if (detected === 'availability') {
        if (!googleAuthed) {
          Alert.alert('Not signed in', 'Please sign in with Google to check your calendar.');
          return;
        }
        setStatusText('Checking your calendar…');
        const availabilityData = await getAvailabilityData();
        input.availabilityData = availabilityData;
        setContextSummary(
          availabilityData.events.length === 0
            ? 'No events in the next 7 days'
            : `${availabilityData.events.length} event${availabilityData.events.length !== 1 ? 's' : ''} in the next 7 days`
        );
      }

      setStatusText('Drafting replies with Claude…');
      const result = await suggestReply(input);
      setReplies(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      Alert.alert('Error', msg);
    } finally {
      setLoading(false);
      setStatusText('');
    }
  };

  const handleCopy = async () => {
    if (!replies) return;
    await Clipboard.setStringAsync(replies[tone]);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  const canSubmit = message.trim().length > 0 && !loading;
  const accentColor = TONE_COLOR[tone];

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">

          {/* Header */}
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>ContextReply</Text>
              <Text style={styles.subtitle}>Smart replies grounded in reality</Text>
            </View>
            <Pressable style={styles.gearBtn} onPress={() => setSettingsVisible(true)}>
              <Text style={styles.gearIcon}>⚙</Text>
            </Pressable>
          </View>

          {/* Notification access banner */}
          {Platform.OS === 'android' && !notifPermission && NotificationListener ? (
            <Pressable style={styles.notifBanner} onPress={() => {
              try { NotificationListener.openNotificationListenerSettings(); } catch {}
            }}>
              <Text style={styles.notifBannerText}>
                Tap to grant Notification Access so replies surface automatically
              </Text>
            </Pressable>
          ) : null}

          {/* Google Auth */}
          <View style={styles.authRow}>
            {googleAuthed ? (
              <>
                <Text style={styles.authConnected}>Google Calendar connected</Text>
                <Pressable onPress={async () => { await signOut(); setGoogleAuthed(false); }}>
                  <Text style={styles.authSignOut}>Sign out</Text>
                </Pressable>
              </>
            ) : (
              <Pressable style={styles.authButton} onPress={async () => {
                try {
                  await GoogleSignin.hasPlayServices();
                  await GoogleSignin.signIn();
                  setGoogleAuthed(true);
                } catch (err: unknown) {
                  const msg = err instanceof Error ? err.message : 'Sign-in failed';
                  Alert.alert('Sign-in error', msg);
                }
              }}>
                <Text style={styles.authButtonText}>Sign in with Google</Text>
              </Pressable>
            )}
          </View>

          {/* Input */}
          <Text style={styles.label}>Incoming message</Text>
          <TextInput
            style={styles.input}
            multiline
            placeholder={'e.g. "What\'s your ETA?" or "Are you free Thursday?"'}
            placeholderTextColor="#555"
            value={message}
            onChangeText={setMessage}
            editable={!loading}
            maxLength={1000}
          />

          {/* Suggest button */}
          <Pressable
            style={[styles.button, { backgroundColor: accentColor }, !canSubmit && styles.buttonDisabled]}
            onPress={handleSuggest}
            disabled={!canSubmit}
          >
            {loading ? (
              <View style={styles.row}>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={[styles.buttonText, { marginLeft: 10 }]}>{statusText || 'Working…'}</Text>
              </View>
            ) : (
              <Text style={styles.buttonText}>Suggest Reply</Text>
            )}
          </Pressable>

          {/* Result card */}
          {(intent || replies) && !loading ? (
            <View style={styles.card}>
              {/* Intent + context */}
              {intent ? (
                <View style={[styles.intentBadge, { backgroundColor: accentColor + '22', borderColor: accentColor + '55' }]}>
                  <Text style={[styles.intentText, { color: accentColor }]}>{INTENT_LABEL[intent]}</Text>
                </View>
              ) : null}
              {contextSummary ? <Text style={styles.contextText}>{contextSummary}</Text> : null}

              {replies ? (
                <>
                  <View style={styles.divider} />

                  {/* Tone tabs */}
                  <View style={styles.toneRow}>
                    {(['formal', 'casual', 'brief'] as Tone[]).map((t) => (
                      <Pressable
                        key={t}
                        style={[styles.toneTab, tone === t && { backgroundColor: TONE_COLOR[t] + '22', borderColor: TONE_COLOR[t] }]}
                        onPress={() => setTone(t)}
                      >
                        <Text style={[styles.toneTabText, tone === t && { color: TONE_COLOR[t] }]}>
                          {TONE_LABEL[t]}
                          {t === defaultTone ? ' ·' : ''}
                        </Text>
                      </Pressable>
                    ))}
                  </View>

                  {/* Reply bubble */}
                  <View style={[styles.bubble, { borderLeftColor: accentColor }]}>
                    <Text style={styles.replyText}>{replies[tone]}</Text>
                  </View>

                  {/* Copy button */}
                  <Pressable style={[styles.copyBtn, copied && { backgroundColor: accentColor + '33' }]} onPress={handleCopy}>
                    <Text style={[styles.copyBtnText, copied && { color: accentColor }]}>
                      {copied ? '✓  Copied!' : 'Copy to clipboard'}
                    </Text>
                  </Pressable>
                </>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Settings modal */}
      <Modal visible={settingsVisible} transparent animationType="slide" onRequestClose={() => setSettingsVisible(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setSettingsVisible(false)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Settings</Text>

            <Text style={styles.modalSection}>DEFAULT TONE</Text>
            {(['formal', 'casual', 'brief'] as Tone[]).map((t) => (
              <Pressable key={t} style={styles.settingRow} onPress={() => saveDefaultTone(t)}>
                <View style={styles.settingLeft}>
                  <View style={[styles.settingDot, { backgroundColor: TONE_COLOR[t] }]} />
                  <Text style={styles.settingText}>{TONE_LABEL[t]}</Text>
                </View>
                {defaultTone === t ? <Text style={[styles.settingCheck, { color: TONE_COLOR[t] }]}>✓</Text> : null}
              </Pressable>
            ))}

            <View style={styles.divider} />
            <Text style={styles.modalSection}>CONTEXT SETUP</Text>
            <Text style={styles.setupHint}>Optional — improves reply quality</Text>

            <Pressable style={styles.settingRow} onPress={() => {
              if (Platform.OS === 'android') Linking.sendIntent('android.settings.ACCESSIBILITY_SETTINGS').catch(() => {});
            }}>
              <View style={styles.settingLeft}>
                <Text style={styles.setupDot}>·</Text>
                <View>
                  <Text style={styles.settingText}>Accessibility Access</Text>
                  <Text style={styles.setupStatus}>Enables overlay suggestions in messaging apps</Text>
                </View>
              </View>
              <Text style={styles.setupAction}>Open</Text>
            </Pressable>

            <Pressable style={styles.settingRow} onPress={() => {
              if (Platform.OS === 'android') {
                Linking.sendIntent('android.settings.NOTIFICATION_SETTINGS').catch(() => {});
              }
            }}>
              <View style={styles.settingLeft}>
                <Text style={styles.setupDot}>·</Text>
                <View>
                  <Text style={styles.settingText}>Suggestion Bubbles</Text>
                  <Text style={styles.setupStatus}>Notifications → More settings → Bubbles</Text>
                </View>
              </View>
              <Text style={styles.setupAction}>Open</Text>
            </Pressable>

            <SetupRow
              label="Google Contacts"
              status={googleContactsCount !== null ? `${googleContactsCount} imported` : 'Not imported'}
              done={googleContactsCount !== null}
              loading={setupLoading === 'google'}
              onPress={handleImportGoogleContacts}
            />
            <SetupRow
              label="Device Contacts"
              status={deviceContactsCount !== null ? `${deviceContactsCount} imported` : 'Not imported'}
              done={deviceContactsCount !== null}
              loading={setupLoading === 'device'}
              onPress={handleImportDeviceContacts}
            />
            <SetupRow
              label="WhatsApp History"
              status={whatsappMessages !== null ? `${whatsappMessages} messages imported` : 'Not imported'}
              done={whatsappMessages !== null}
              loading={setupLoading === 'whatsapp'}
              onPress={handleImportWhatsApp}
            />

            <Pressable style={styles.modalClose} onPress={() => setSettingsVisible(false)}>
              <Text style={styles.modalCloseText}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const PURPLE = '#6366f1';
const BG = '#0c0c0e';
const SURFACE = '#18181b';
const BORDER = '#27272a';
const TEXT = '#f4f4f5';
const MUTED = '#71717a';

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  flex: { flex: 1 },
  scroll: { padding: 24, paddingTop: 16 },

  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  title: { fontSize: 26, fontWeight: '700', color: TEXT, letterSpacing: -0.5 },
  subtitle: { fontSize: 14, color: MUTED, marginTop: 4 },
  gearBtn: { padding: 4 },
  gearIcon: { fontSize: 22, color: MUTED },

  label: { fontSize: 12, fontWeight: '600', color: MUTED, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
  input: {
    backgroundColor: SURFACE, borderRadius: 14, borderWidth: 1, borderColor: BORDER,
    padding: 16, fontSize: 16, color: TEXT, minHeight: 110, textAlignVertical: 'top', marginBottom: 16,
  },

  button: { borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 24 },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center' },

  card: { backgroundColor: SURFACE, borderRadius: 16, borderWidth: 1, borderColor: BORDER, padding: 20 },
  intentBadge: { borderRadius: 20, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 5, alignSelf: 'flex-start', marginBottom: 8 },
  intentText: { fontSize: 13, fontWeight: '500' },
  contextText: { color: MUTED, fontSize: 13, marginBottom: 4 },
  divider: { height: 1, backgroundColor: BORDER, marginVertical: 16 },

  toneRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  toneTab: {
    flex: 1, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: BORDER,
    alignItems: 'center', backgroundColor: 'transparent',
  },
  toneTabText: { fontSize: 13, fontWeight: '600', color: MUTED },

  bubble: { borderLeftWidth: 3, paddingLeft: 14, marginBottom: 16 },
  replyText: { color: TEXT, fontSize: 16, lineHeight: 26 },

  copyBtn: { borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignSelf: 'flex-start', backgroundColor: BORDER },
  copyBtnText: { color: '#a1a1aa', fontSize: 14, fontWeight: '500' },

  authRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, paddingHorizontal: 2 },
  authConnected: { color: '#4ade80', fontSize: 13, fontWeight: '500' },
  authSignOut: { color: MUTED, fontSize: 13, textDecorationLine: 'underline' },
  authButton: { backgroundColor: '#1d4ed8', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 18 },
  authButtonText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  notifBanner: { backgroundColor: '#451a03', borderRadius: 12, borderWidth: 1, borderColor: '#92400e', padding: 14, marginBottom: 16 },
  notifBannerText: { color: '#fcd34d', fontSize: 13, lineHeight: 19 },

  modalOverlay: { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#1c1c1e', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 40 },
  modalHandle: { width: 36, height: 4, backgroundColor: BORDER, borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: TEXT, marginBottom: 24 },
  modalSection: { fontSize: 11, fontWeight: '600', color: MUTED, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: BORDER },
  settingLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  settingDot: { width: 10, height: 10, borderRadius: 5 },
  settingText: { fontSize: 16, color: TEXT },
  settingCheck: { fontSize: 18, fontWeight: '700' },
  modalClose: { marginTop: 24, backgroundColor: PURPLE, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  modalCloseText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  setupHint: { color: MUTED, fontSize: 12, marginBottom: 12 },
  setupDot: { fontSize: 18, color: MUTED, width: 20, textAlign: 'center' },
  setupDotDone: { color: '#4ade80' },
  setupStatus: { fontSize: 12, color: MUTED, marginTop: 1 },
  setupAction: { fontSize: 13, color: PURPLE, fontWeight: '600' },
});
