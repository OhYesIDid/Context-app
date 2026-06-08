import AsyncStorage from '@react-native-async-storage/async-storage';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Modal,
  NativeModules,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

const { ContextReplySettings } = NativeModules;

// Lazy-load the Android-only native module to avoid a startup crash.
type NotificationPayload = { bigText?: string; text?: string };
const NotificationListener = Platform.OS === 'android'
  ? (() => { try { return require('expo-android-notification-listener-service').default; } catch { return null; } })()
  : null;

import { suggestReply } from './src/services/claude';
import { getAllContacts, updateContactPreferences } from './src/services/database';
import { importDeviceContacts } from './src/services/deviceContacts';
import { configureGoogleSignin, initAuth, isSignedIn, requestGmailScope, signOut } from './src/services/googleAuth';
import { getCalendarData } from './src/services/googleCalendar';
import { getBookingsContext } from './src/services/googleBookings';
import { getEtaData } from './src/services/googleMaps';
import { importGoogleContacts } from './src/services/googlePeople';
import { syncStyleProfile } from './src/services/styleSync';
import { pickAndParseWhatsAppExport } from './src/services/whatsappParser';
import type { Contact, EnrichmentData, Intent, ReplyOptions, Relationship, SuggestReplyInput, Tone } from './src/types';
import { ENRICHMENT_PREFERENCES, ENRICHMENT_STATUS, INTENT_ENRICHMENTS, detectIntents, requiredEnrichments, summariseEnrichments } from './src/utils/intentDetector';

const INTENT_LABEL: Record<Intent, string> = {
  eta: '📍 ETA request',
  availability: '📅 Availability request',
  booking: '🎫 Booking lookup',
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
  const [intent, setIntent] = useState<Intent[]>([]);
  const [contextSummary, setContextSummary] = useState('');
  const [copied, setCopied] = useState(false);
  const [googleAuthed, setGoogleAuthed] = useState(false);
  const [notifPermission, setNotifPermission] = useState(false);
  const [bubbleLabel, setBubbleLabel] = useState('Notifications → Bubbles');
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [googleContactsCount, setGoogleContactsCount] = useState<number | null>(null);
  const [deviceContactsCount, setDeviceContactsCount] = useState<number | null>(null);
  const [whatsappMessages, setWhatsappMessages] = useState<number | null>(null);
  const [setupLoading, setSetupLoading] = useState<string | null>(null);
  const [skipGroupMessages, setSkipGroupMessages] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [settingsPage, setSettingsPage] = useState<'main' | 'tone' | 'context' | 'contacts' | 'import' | 'enhancements'>('main');
  const [enrichmentPrefs, setEnrichmentPrefs] = useState<Record<string, Record<string, string>>>({});
  const [gmailConnected, setGmailConnected] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shareText, setShareText] = useState<string | null>(null);
  const [shareReply, setShareReply] = useState('');
  const [shareLoading, setShareLoading] = useState(false);

  // Reset copied indicator when switching tones
  useEffect(() => { setCopied(false); }, [tone]);

  // Load contacts when settings modal opens
  useEffect(() => {
    if (settingsVisible) {
      getAllContacts().then(setContacts).catch(() => {});
    }
  }, [settingsVisible]);

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
    // Request location permissions for ETA features (background needed for NLS)
    if (Platform.OS === 'android') {
      (async () => {
        try {
          const bgKey = PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION;
          const bgAlready = await PermissionsAndroid.check(bgKey);
          if (!bgAlready) {
            const fineAlready = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
            if (!fineAlready) {
              await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, {
                title: 'Location access',
                message: 'Protxt uses your location to estimate your travel time when someone asks where you are.',
                buttonPositive: 'Allow',
                buttonNegative: 'Not now',
              });
            }
            if (Platform.Version >= 29) {
              await PermissionsAndroid.request(bgKey, {
                title: 'Background location',
                message: 'To estimate your ETA when a message arrives, Protxt needs location access even when the app is closed. Tap "Allow all the time" on the next screen.',
                buttonPositive: 'Go to settings',
                buttonNegative: 'Skip',
              });
            }
          }
        } catch {}
      })();
    }
    // Use native module for accurate NLS check (expo module returns true if any NLS is listed)
    if (Platform.OS === 'android' && ContextReplySettings) {
      ContextReplySettings.isNlsConnected().then((ok: boolean) => setNotifPermission(ok)).catch(() => {});
      ContextReplySettings.getSkipGroupMessages().then((skip: boolean) => setSkipGroupMessages(skip)).catch(() => {});
      ContextReplySettings.getBubbleSettingsLabel().then((label: string) => setBubbleLabel(label)).catch(() => {});
      // Load all enrichment preferences so settings UI and fetchers have them ready
      (async () => {
        const prefs: Record<string, Record<string, string>> = {};
        for (const [enrichment, fields] of Object.entries(ENRICHMENT_PREFERENCES)) {
          prefs[enrichment] = {};
          for (const field of fields ?? []) {
            const val = await ContextReplySettings.getEnrichmentPreference(enrichment, field.key).catch(() => null);
            prefs[enrichment][field.key] = val ?? field.defaultValue;
          }
        }
        setEnrichmentPrefs(prefs);
      })();
      ContextReplySettings.getSharedText().then((text: string | null) => {
        if (text) { setShareText(text); setShareReply(''); }
      }).catch(() => {});
      // Drain the Kotlin-side StyleEditQueue into SQLite and rebuild the cached
      // style profile so the next background suggestion is personalised.
      syncStyleProfile();
    }
  }, []);

  // Re-check for share intents when the app comes back to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || Platform.OS !== 'android' || !ContextReplySettings) return;
      ContextReplySettings.getSharedText().then((text: string | null) => {
        if (text) { setShareText(text); setShareReply(''); }
      }).catch(() => {});
    });
    return () => sub.remove();
  }, []);

  // Auto-generate suggestion when a share intent arrives (fetches ETA/calendar if needed).
  useEffect(() => {
    if (!shareText) return;
    setShareLoading(true);
    (async () => {
      try {
        const detected = detectIntents(shareText);
        const enrichments: EnrichmentData = {};
        for (const key of requiredEnrichments(detected)) {
          try {
            if (key === 'maps') enrichments.maps = await getEtaData(enrichmentPrefs.maps?.transportMode ?? 'driving');
            if (key === 'calendar' && googleAuthed) enrichments.calendar = await getCalendarData(shareText);
            if (key === 'bookings' && gmailConnected) enrichments.bookings = await getBookingsContext(Number(enrichmentPrefs.bookings?.lookbackDays ?? 30));
          } catch {}
        }
        const input: SuggestReplyInput = { originalMessage: shareText, intents: detected, enrichments };
        const r = await suggestReply(input);
        setShareReply(r.casual);
      } catch {} finally {
        setShareLoading(false);
      }
    })();
  }, [shareText]);

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

  const updateContactPref = async (
    id: string,
    field: 'relationship' | 'preferredTone',
    value: string | undefined,
  ) => {
    setContacts((prev) =>
      prev.map((c) => (c.id === id ? { ...c, [field]: value } : c))
    );
    const updated = contacts.find((c) => c.id === id);
    if (!updated) return;
    const rel = field === 'relationship' ? (value as Relationship | undefined) : updated.relationship;
    const tone = field === 'preferredTone' ? (value as Tone | undefined) : updated.preferredTone;
    await updateContactPreferences(id, rel, tone);
    syncStyleProfile();
  };

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
      const detected = detectIntents(message);
      setIntent(detected);
      const enrichments: EnrichmentData = {};
      for (const key of requiredEnrichments(detected)) {
        setStatusText(ENRICHMENT_STATUS[key]);
        try {
          if (key === 'maps') enrichments.maps = await getEtaData(enrichmentPrefs.maps?.transportMode ?? 'driving');
          if (key === 'bookings') {
            if (!gmailConnected) { setStatusText('Connect Gmail in Settings → Enhancements to use bookings'); }
            else enrichments.bookings = await getBookingsContext(Number(enrichmentPrefs.bookings?.lookbackDays ?? 30));
          }
          if (key === 'calendar') {
            if (!googleAuthed) {
              setStatusText('Sign in with Google to check your calendar');
            } else {
              enrichments.calendar = await getCalendarData(message);
            }
          }
        } catch {}
      }
      const summary = summariseEnrichments(enrichments);
      if (summary) setContextSummary(summary);
      setStatusText('Drafting replies with Claude…');
      const input: SuggestReplyInput = { originalMessage: message, intents: detected, enrichments };
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

          {/* Setup card — shown until notification access + Google sign-in are both done */}
          {Platform.OS === 'android' && (!notifPermission || !googleAuthed) ? (
            <View style={styles.setupCard}>
              <Text style={styles.setupCardTitle}>Get started</Text>
              {[
                {
                  label: 'Notification access',
                  done: notifPermission,
                  subtitle: 'Required for automatic reply bubbles',
                  action: 'Enable',
                  onPress: () => { try { NotificationListener?.openNotificationListenerSettings(); } catch {} },
                },
                {
                  label: 'Suggestion bubbles',
                  done: notifPermission,
                  subtitle: `Open App settings → ${bubbleLabel}`,
                  action: 'Open',
                  onPress: () => ContextReplySettings?.openAppNotificationSettings?.(),
                },
                {
                  label: 'Google Calendar (optional)',
                  done: googleAuthed,
                  subtitle: 'Checks your calendar for availability questions',
                  action: 'Sign in',
                  onPress: async () => {
                    try {
                      await GoogleSignin.hasPlayServices();
                      await GoogleSignin.signIn();
                      setGoogleAuthed(true);
                    } catch {}
                  },
                },
              ].map((step) => (
                <View key={step.label} style={styles.setupCardRow}>
                  <Text style={[styles.setupCardDot, step.done && styles.setupCardDotDone]}>
                    {step.done ? '✓' : '·'}
                  </Text>
                  <View style={styles.setupCardContent}>
                    <Text style={styles.setupCardLabel}>{step.label}</Text>
                    <Text style={styles.setupCardSub}>{step.subtitle}</Text>
                  </View>
                  {!step.done && (
                    <Pressable onPress={step.onPress}>
                      <Text style={styles.setupCardAction}>{step.action}</Text>
                    </Pressable>
                  )}
                </View>
              ))}
            </View>
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
          {(intent.length > 0 || replies) && !loading ? (
            <View style={styles.card}>
              {/* Intent + context */}
              {intent.filter((i) => i !== 'other').map((i) => (
                <View key={i} style={[styles.intentBadge, { backgroundColor: accentColor + '22', borderColor: accentColor + '55' }]}>
                  <Text style={[styles.intentText, { color: accentColor }]}>{INTENT_LABEL[i]}</Text>
                </View>
              ))}
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
      <Modal visible={settingsVisible} transparent animationType="slide" onRequestClose={() => { setSettingsPage('main'); setContactSearch(''); setSettingsVisible(false); }}>
        <Pressable style={styles.modalOverlay} onPress={() => { setSettingsPage('main'); setContactSearch(''); setSettingsVisible(false); }}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <View style={styles.modalHandle} />

            {/* ── Main category page ── */}
            {settingsPage === 'main' && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <Text style={styles.modalTitle}>Settings</Text>
                {([
                  { page: 'tone', label: 'Default Tone', value: TONE_LABEL[defaultTone] },
                  { page: 'context', label: 'Context Setup', value: notifPermission ? 'Connected' : 'Setup needed' },
                  { page: 'contacts', label: 'Contacts', value: contacts.length > 0 ? `${contacts.length} contacts` : 'None imported' },
                  { page: 'import', label: 'Data Import', value: 'Manage' },
                  { page: 'enhancements', label: 'Enhancements', value: 'Location & more' },
                ] as { page: typeof settingsPage; label: string; value: string }[]).map(({ page, label, value }) => (
                  <Pressable key={page} style={styles.categoryRow} onPress={() => setSettingsPage(page)}>
                    <Text style={styles.categoryLabel}>{label}</Text>
                    <View style={styles.categoryRight}>
                      <Text style={styles.categoryValue}>{value}</Text>
                      <Text style={styles.chevron}>›</Text>
                    </View>
                  </Pressable>
                ))}
                <Pressable style={styles.modalClose} onPress={() => { setSettingsPage('main'); setContactSearch(''); setSettingsVisible(false); }}>
                  <Text style={styles.modalCloseText}>Done</Text>
                </Pressable>
              </ScrollView>
            )}

            {/* ── Default Tone page ── */}
            {settingsPage === 'tone' && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={styles.subPageHeader}>
                  <Pressable onPress={() => setSettingsPage('main')} style={styles.backBtn}>
                    <Text style={styles.backBtnText}>‹ Settings</Text>
                  </Pressable>
                  <Text style={styles.subPageTitle}>Default Tone</Text>
                </View>
                {(['formal', 'casual', 'brief'] as Tone[]).map((t) => (
                  <Pressable key={t} style={styles.settingRow} onPress={() => saveDefaultTone(t)}>
                    <View style={styles.settingLeft}>
                      <View style={[styles.settingDot, { backgroundColor: TONE_COLOR[t] }]} />
                      <Text style={styles.settingText}>{TONE_LABEL[t]}</Text>
                    </View>
                    {defaultTone === t ? <Text style={[styles.settingCheck, { color: TONE_COLOR[t] }]}>✓</Text> : null}
                  </Pressable>
                ))}
              </ScrollView>
            )}

            {/* ── Context Setup page ── */}
            {settingsPage === 'context' && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={styles.subPageHeader}>
                  <Pressable onPress={() => setSettingsPage('main')} style={styles.backBtn}>
                    <Text style={styles.backBtnText}>‹ Settings</Text>
                  </Pressable>
                  <Text style={styles.subPageTitle}>Context Setup</Text>
                </View>
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
                  if (Platform.OS === 'android') ContextReplySettings?.openAppNotificationSettings?.();
                }}>
                  <View style={styles.settingLeft}>
                    <Text style={styles.setupDot}>·</Text>
                    <View>
                      <Text style={styles.settingText}>Suggestion Bubbles</Text>
                      <Text style={styles.setupStatus}>Tap Open, then enable {bubbleLabel}</Text>
                    </View>
                  </View>
                  <Text style={styles.setupAction}>Open</Text>
                </Pressable>
                <View style={[styles.settingRow, { borderBottomWidth: 1, borderBottomColor: BORDER }]}>
                  <View style={styles.settingLeft}>
                    <Text style={styles.setupDot}>·</Text>
                    <View>
                      <Text style={styles.settingText}>Skip group messages</Text>
                      <Text style={styles.setupStatus}>Only suggest replies for 1-to-1 chats</Text>
                    </View>
                  </View>
                  <Switch
                    value={skipGroupMessages}
                    onValueChange={(v) => { setSkipGroupMessages(v); ContextReplySettings?.setSkipGroupMessages?.(v); }}
                    trackColor={{ false: BORDER, true: PURPLE + '99' }}
                    thumbColor={skipGroupMessages ? PURPLE : MUTED}
                  />
                </View>
              </ScrollView>
            )}

            {/* ── Contacts page ── */}
            {settingsPage === 'contacts' && (
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                <View style={styles.subPageHeader}>
                  <Pressable onPress={() => { setSettingsPage('main'); setContactSearch(''); }} style={styles.backBtn}>
                    <Text style={styles.backBtnText}>‹ Settings</Text>
                  </Pressable>
                  <Text style={styles.subPageTitle}>Contacts</Text>
                </View>
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search contacts…"
                  placeholderTextColor={MUTED}
                  value={contactSearch}
                  onChangeText={setContactSearch}
                  autoCorrect={false}
                />
                {contacts.length === 0 ? (
                  <Text style={styles.setupHint}>No contacts imported. Go to Data Import to add contacts.</Text>
                ) : (() => {
                  const shown = contactSearch
                    ? contacts.filter((c) => c.displayName.toLowerCase().includes(contactSearch.toLowerCase()))
                    : contacts.slice(0, 10);
                  return <>
                    {!contactSearch && <Text style={styles.setupHint}>Top 10 by interactions — search for others</Text>}
                    {shown.map((c) => (
                      <View key={c.id} style={styles.contactCard}>
                        <Text style={styles.contactName}>{c.displayName}</Text>
                        <Text style={styles.chipLabel}>Relationship</Text>
                        <View style={styles.chipRow}>
                          {(['friend', 'colleague', 'family', 'partner', 'other'] as Relationship[]).map((r) => (
                            <Pressable key={r}
                              style={[styles.chip, c.relationship === r && styles.chipActive]}
                              onPress={() => updateContactPref(c.id, 'relationship', c.relationship === r ? undefined : r)}>
                              <Text style={[styles.chipText, c.relationship === r && styles.chipTextActive]}>
                                {r.charAt(0).toUpperCase() + r.slice(1)}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                        <Text style={styles.chipLabel}>Preferred tone</Text>
                        <View style={styles.chipRow}>
                          {(['casual', 'formal', 'brief'] as Tone[]).map((t) => (
                            <Pressable key={t}
                              style={[styles.chip, c.preferredTone === t && styles.chipActive]}
                              onPress={() => updateContactPref(c.id, 'preferredTone', c.preferredTone === t ? undefined : t)}>
                              <Text style={[styles.chipText, c.preferredTone === t && styles.chipTextActive]}>
                                {TONE_LABEL[t]}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                      </View>
                    ))}
                    {shown.length === 0 && <Text style={styles.setupHint}>No contacts match "{contactSearch}"</Text>}
                  </>;
                })()}
              </ScrollView>
            )}

            {/* ── Data Import page ── */}
            {settingsPage === 'import' && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={styles.subPageHeader}>
                  <Pressable onPress={() => setSettingsPage('main')} style={styles.backBtn}>
                    <Text style={styles.backBtnText}>‹ Settings</Text>
                  </Pressable>
                  <Text style={styles.subPageTitle}>Data Import</Text>
                </View>
                <Text style={styles.setupHint}>Optional — improves reply quality</Text>
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
              </ScrollView>
            )}

            {/* ── Enhancements page ── */}
            {settingsPage === 'enhancements' && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={styles.subPageHeader}>
                  <Pressable onPress={() => setSettingsPage('main')} style={styles.backBtn}>
                    <Text style={styles.backBtnText}>‹ Settings</Text>
                  </Pressable>
                  <Text style={styles.subPageTitle}>Enhancements</Text>
                </View>
                {(Object.entries(ENRICHMENT_PREFERENCES) as [string, typeof ENRICHMENT_PREFERENCES[keyof typeof ENRICHMENT_PREFERENCES]][]).map(([enrichment, fields]) => (
                  <View key={enrichment}>
                    <Text style={[styles.modalSection, { marginTop: 8 }]}>
                      {enrichment === 'maps' ? 'Google Maps' : enrichment === 'bookings' ? 'Gmail Bookings' : enrichment}
                    </Text>
                    {enrichment === 'bookings' && (
                      <View style={[styles.settingRow, { marginBottom: 12 }]}>
                        <View>
                          <Text style={styles.settingText}>{gmailConnected ? 'Gmail connected' : 'Connect Gmail'}</Text>
                          <Text style={styles.setupStatus}>{gmailConnected ? 'Bookings will be checked automatically' : 'Required to look up reservations'}</Text>
                        </View>
                        {gmailConnected
                          ? <Text style={styles.authConnected}>✓ Connected</Text>
                          : <Pressable style={styles.authButton} onPress={async () => {
                              if (!googleAuthed) {
                                Alert.alert('Sign in first', 'Please sign in with Google before connecting Gmail.');
                                return;
                              }
                              const ok = await requestGmailScope();
                              if (ok) setGmailConnected(true);
                              else Alert.alert('Permission denied', 'Gmail access is needed to look up your bookings.');
                            }}>
                              <Text style={styles.authButtonText}>Connect</Text>
                            </Pressable>
                        }
                      </View>
                    )}
                    {(fields ?? []).map((field) => (
                      <View key={field.key} style={{ marginBottom: 20 }}>
                        <Text style={{ color: TEXT, fontSize: 15, marginBottom: 10 }}>{field.label}</Text>
                        <View style={styles.chipRow}>
                          {field.options.map((opt) => {
                            const active = (enrichmentPrefs[enrichment]?.[field.key] ?? field.defaultValue) === opt.value;
                            return (
                              <Pressable
                                key={opt.value}
                                style={[styles.chip, active && styles.chipActive]}
                                onPress={() => {
                                  setEnrichmentPrefs((prev) => ({
                                    ...prev,
                                    [enrichment]: { ...prev[enrichment], [field.key]: opt.value },
                                  }));
                                  ContextReplySettings?.setEnrichmentPreference?.(enrichment, field.key, opt.value);
                                }}
                              >
                                <Text style={[styles.chipText, active && styles.chipTextActive]}>{opt.label}</Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      </View>
                    ))}
                  </View>
                ))}
              </ScrollView>
            )}

          </Pressable>
        </Pressable>
      </Modal>

      {/* Share intent modal */}
      <Modal visible={shareText !== null} transparent animationType="slide" onRequestClose={() => setShareText(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setShareText(null)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Suggest Reply</Text>
            <Text style={styles.modalSection}>Incoming message</Text>
            <Text style={{ color: MUTED, fontSize: 15, lineHeight: 22, marginBottom: 16 }} numberOfLines={4}>
              {shareText}
            </Text>
            {shareLoading ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <ActivityIndicator color={PURPLE} size="small" />
                <Text style={{ color: MUTED, fontSize: 14 }}>Drafting reply…</Text>
              </View>
            ) : shareReply ? (
              <>
                <Text style={styles.modalSection}>Suggested reply</Text>
                <TextInput
                  style={[styles.input, { marginBottom: 16 }]}
                  value={shareReply}
                  onChangeText={setShareReply}
                  multiline
                />
              </>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable
                style={[styles.modalClose, { flex: 1, backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER }]}
                onPress={() => setShareText(null)}
              >
                <Text style={[styles.modalCloseText, { color: MUTED }]}>Cancel</Text>
              </Pressable>
              {shareReply ? (
                <Pressable
                  style={[styles.modalClose, { flex: 2 }]}
                  onPress={async () => {
                    await Clipboard.setStringAsync(shareReply);
                    setShareText(null);
                  }}
                >
                  <Text style={styles.modalCloseText}>Copy & Close</Text>
                </Pressable>
              ) : null}
            </View>
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

  setupCard: { backgroundColor: SURFACE, borderRadius: 14, borderWidth: 1, borderColor: BORDER, padding: 16, marginBottom: 20 },
  setupCardTitle: { fontSize: 13, fontWeight: '600', color: MUTED, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 },
  setupCardRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  setupCardDot: { fontSize: 18, color: MUTED, width: 18, textAlign: 'center', lineHeight: 22 },
  setupCardDotDone: { color: '#4ade80' },
  setupCardContent: { flex: 1 },
  setupCardLabel: { fontSize: 14, color: TEXT, fontWeight: '500' },
  setupCardSub: { fontSize: 12, color: MUTED, marginTop: 1 },
  setupCardAction: { fontSize: 13, color: PURPLE, fontWeight: '600', paddingTop: 2 },

  modalOverlay: { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#1c1c1e', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 40, maxHeight: '90%' },
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

  categoryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: BORDER },
  categoryLabel: { fontSize: 16, color: TEXT },
  categoryRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  categoryValue: { fontSize: 14, color: MUTED },
  chevron: { fontSize: 20, color: MUTED, lineHeight: 22 },

  subPageHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, gap: 8 },
  backBtn: { paddingRight: 4 },
  backBtnText: { fontSize: 16, color: PURPLE },
  subPageTitle: { fontSize: 18, fontWeight: '700', color: TEXT },

  searchInput: { backgroundColor: SURFACE, borderRadius: 10, borderWidth: 1, borderColor: BORDER, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: TEXT, marginBottom: 16 },

  contactCard: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: BORDER },
  contactName: { color: TEXT, fontSize: 14, fontWeight: '600', marginBottom: 8 },
  chipLabel: { color: MUTED, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: BORDER },
  chipActive: { backgroundColor: PURPLE + '33', borderColor: PURPLE },
  chipText: { color: MUTED, fontSize: 12 },
  chipTextActive: { color: PURPLE, fontWeight: '600' },
  setupDot: { fontSize: 18, color: MUTED, width: 20, textAlign: 'center' },
  setupDotDone: { color: '#4ade80' },
  setupStatus: { fontSize: 12, color: MUTED, marginTop: 1 },
  setupAction: { fontSize: 13, color: PURPLE, fontWeight: '600' },
});
