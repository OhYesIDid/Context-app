import AsyncStorage from '@react-native-async-storage/async-storage';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Modal,
  NativeModules,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

const { ProTxtSettings } = NativeModules;

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
import type { Contact, EnrichmentData, Intent, Relationship, SuggestReplyInput, Tone } from './src/types';
import { ENRICHMENT_PREFERENCES, detectIntents, requiredEnrichments } from './src/utils/intentDetector';
import SetupWizard, { type SetupResult } from './src/components/SetupWizard';

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
const SETUP_COMPLETE_KEY = 'setup_complete';

export default function App() {
  const [defaultTone, setDefaultToneState] = useState<Tone>('casual');
  const [googleAuthed, setGoogleAuthed] = useState(false);
  const [notifPermission, setNotifPermission] = useState(false);
  const [accessibilityEnabled, setAccessibilityEnabled] = useState(false);
  const [bubbleLabel, setBubbleLabel] = useState('Notifications → Bubbles');
  const [googleContactsCount, setGoogleContactsCount] = useState<number | null>(null);
  const [deviceContactsCount, setDeviceContactsCount] = useState<number | null>(null);
  const [whatsappMessages, setWhatsappMessages] = useState<number | null>(null);
  const [setupLoading, setSetupLoading] = useState<string | null>(null);
  const [skipGroupMessages, setSkipGroupMessages] = useState(false);
  const [suggestAllMessages, setSuggestAllMessagesState] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsVisible, setContactsVisible] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [enrichmentPrefs, setEnrichmentPrefs] = useState<Record<string, Record<string, string>>>({});
  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailSettingsVisible, setGmailSettingsVisible] = useState(false);
  const [mapsSettingsVisible, setMapsSettingsVisible] = useState(false);
  const [serviceSettingsVisible, setServiceSettingsVisible] = useState(false);
  const [shareText, setShareText] = useState<string | null>(null);
  const [shareReply, setShareReply] = useState('');
  const [shareLoading, setShareLoading] = useState(false);
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);

  useEffect(() => {
    if (contactsVisible) {
      getAllContacts().then(setContacts).catch(() => {});
    }
  }, [contactsVisible]);

  useEffect(() => {
    AsyncStorage.multiGet([
      DEFAULT_TONE_KEY,
      GOOGLE_CONTACTS_COUNT_KEY,
      DEVICE_CONTACTS_COUNT_KEY,
      WHATSAPP_IMPORT_KEY,
      SETUP_COMPLETE_KEY,
    ]).then((pairs) => {
      const map = Object.fromEntries(pairs.map(([k, v]) => [k, v]));
      const saved = map[DEFAULT_TONE_KEY];
      if (saved === 'formal' || saved === 'casual' || saved === 'brief') setDefaultToneState(saved);
      const gc = map[GOOGLE_CONTACTS_COUNT_KEY];
      if (gc !== null) setGoogleContactsCount(Number(gc));
      const dc = map[DEVICE_CONTACTS_COUNT_KEY];
      if (dc !== null) setDeviceContactsCount(Number(dc));
      const wa = map[WHATSAPP_IMPORT_KEY];
      if (wa !== null) setWhatsappMessages(Number(wa));
      setSetupComplete(map[SETUP_COMPLETE_KEY] === 'true');
    });
    configureGoogleSignin();
    initAuth().then(() => setGoogleAuthed(isSignedIn()));
    if (Platform.OS === 'android' && ProTxtSettings) {
      ProTxtSettings.isNlsConnected().then((ok: boolean) => setNotifPermission(ok)).catch(() => {});
      ProTxtSettings.isAccessibilityServiceEnabled().then((ok: boolean) => setAccessibilityEnabled(ok)).catch(() => {});
      ProTxtSettings.getSkipGroupMessages().then((skip: boolean) => setSkipGroupMessages(skip)).catch(() => {});
      ProTxtSettings.getSuggestAllMessages().then((all: boolean) => setSuggestAllMessagesState(all)).catch(() => {});
      ProTxtSettings.getBubbleSettingsLabel().then((label: string) => setBubbleLabel(label)).catch(() => {});
      (async () => {
        const prefs: Record<string, Record<string, string>> = {};
        for (const [enrichment, fields] of Object.entries(ENRICHMENT_PREFERENCES)) {
          prefs[enrichment] = {};
          for (const field of fields ?? []) {
            const val = await ProTxtSettings.getEnrichmentPreference(enrichment, field.key).catch(() => null);
            prefs[enrichment][field.key] = val ?? field.defaultValue;
          }
        }
        setEnrichmentPrefs(prefs);
      })();
      ProTxtSettings.getSharedText().then((text: string | null) => {
        if (text) { setShareText(text); setShareReply(''); }
      }).catch(() => {});
      syncStyleProfile();
    }
    getAllContacts().then(setContacts).catch(() => {});
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || Platform.OS !== 'android' || !ProTxtSettings) return;
      ProTxtSettings.isNlsConnected().then((ok: boolean) => setNotifPermission(ok)).catch(() => {});
      ProTxtSettings.isAccessibilityServiceEnabled().then((ok: boolean) => setAccessibilityEnabled(ok)).catch(() => {});
      ProTxtSettings.getSharedText().then((text: string | null) => {
        if (text) { setShareText(text); setShareReply(''); }
      }).catch(() => {});
    });
    return () => sub.remove();
  }, []);

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
        const input: SuggestReplyInput = { originalMessage: shareText, intents: detected as Intent[], enrichments };
        const r = await suggestReply(input);
        setShareReply(r.casual);
      } catch {} finally {
        setShareLoading(false);
      }
    })();
  }, [shareText]);

  const updateContactPref = async (
    id: string,
    field: 'relationship' | 'preferredTone',
    value: string | undefined,
  ) => {
    setContacts((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
    const updated = contacts.find((c) => c.id === id);
    if (!updated) return;
    const rel = field === 'relationship' ? (value as Relationship | undefined) : updated.relationship;
    const tone = field === 'preferredTone' ? (value as Tone | undefined) : updated.preferredTone;
    await updateContactPreferences(id, rel, tone);
    syncStyleProfile();
  };

  const saveDefaultTone = async (t: Tone) => {
    setDefaultToneState(t);
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

  const handleSetupComplete = (result: SetupResult) => {
    setGoogleAuthed(result.googleAuthed);
    setNotifPermission(result.notifPermission);
    if (result.googleContactsCount !== null) setGoogleContactsCount(result.googleContactsCount);
    if (result.deviceContactsCount !== null) setDeviceContactsCount(result.deviceContactsCount);
    if (result.whatsappMessages !== null) setWhatsappMessages(result.whatsappMessages);
    setSetupComplete(true);
  };

  if (setupComplete === null) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: BG }} />
      </SafeAreaProvider>
    );
  }
  if (!setupComplete) {
    return (
      <SafeAreaProvider>
        <SetupWizard onComplete={handleSetupComplete} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <ScrollView style={styles.flex} contentContainerStyle={styles.scroll}>

        <View style={styles.header}>
          <Text style={styles.title}>ConTxt</Text>
          <Text style={styles.subtitle}>Reply suggestions in the background</Text>
        </View>

        {/* SERVICE — collapsed when all active, expanded when action needed */}
        <Text style={styles.sectionLabel}>SERVICE</Text>
        <View style={styles.sectionCard}>
          {notifPermission && accessibilityEnabled ? (
            <Pressable style={[styles.settingRow, { borderBottomWidth: 0 }]} onPress={() => setServiceSettingsVisible(true)}>
              <View style={styles.settingLeft}>
                <View style={[styles.statusDot, { backgroundColor: '#4ade80' }]} />
                <Text style={styles.settingText}>Service active</Text>
              </View>
              <Text style={[styles.categoryValue, { fontSize: 12 }]}>Manage ›</Text>
            </Pressable>
          ) : (
            <>
              <Pressable
                style={styles.settingRow}
                onPress={() => Linking.sendIntent('android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS').catch(() => {})}
              >
                <View style={styles.settingLeft}>
                  <View style={[styles.statusDot, { backgroundColor: notifPermission ? '#4ade80' : '#f87171' }]} />
                  <View>
                    <Text style={styles.settingText}>Notification access</Text>
                    <Text style={styles.setupStatus}>{notifPermission ? 'Listening for messages' : 'Tap to enable'}</Text>
                  </View>
                </View>
                {!notifPermission && <Text style={styles.setupAction}>Open</Text>}
              </Pressable>
              <Pressable
                style={styles.settingRow}
                onPress={() => ProTxtSettings?.openAccessibilitySettings?.()}
              >
                <View style={styles.settingLeft}>
                  <View style={[styles.statusDot, { backgroundColor: accessibilityEnabled ? '#4ade80' : MUTED }]} />
                  <View>
                    <Text style={styles.settingText}>Keyboard overlay</Text>
                    <Text style={styles.setupStatus}>{accessibilityEnabled ? 'Active' : 'Off — tap to enable'}</Text>
                  </View>
                </View>
                {!accessibilityEnabled && <Text style={styles.setupAction}>Enable</Text>}
              </Pressable>
              <Pressable
                style={[styles.settingRow, { borderBottomWidth: 0 }]}
                onPress={() => ProTxtSettings?.openAppNotificationSettings?.()}
              >
                <View style={styles.settingLeft}>
                  <View style={[styles.statusDot, { backgroundColor: MUTED }]} />
                  <View>
                    <Text style={styles.settingText}>Suggestion bubbles</Text>
                    <Text style={styles.setupStatus}>Check {bubbleLabel} is enabled</Text>
                  </View>
                </View>
                <Text style={styles.setupAction}>Open</Text>
              </Pressable>
            </>
          )}
        </View>

        {/* BEHAVIOUR */}
        <Text style={styles.sectionLabel}>BEHAVIOUR</Text>
        <View style={styles.sectionCard}>
          <View style={styles.settingRow}>
            <Text style={styles.settingText}>Default tone</Text>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {(['formal', 'casual', 'brief'] as Tone[]).map((t) => (
                <Pressable
                  key={t}
                  style={[styles.chip, defaultTone === t && { borderColor: TONE_COLOR[t], backgroundColor: TONE_COLOR[t] + '22' }]}
                  onPress={() => saveDefaultTone(t)}
                >
                  <Text style={[styles.chipText, defaultTone === t && { color: TONE_COLOR[t], fontWeight: '600' }]}>
                    {TONE_LABEL[t]}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={styles.settingRow}>
            <View style={{ flex: 1, marginRight: 16 }}>
              <Text style={styles.settingText}>Skip group messages</Text>
              <Text style={styles.setupStatus}>Only suggest replies for 1-to-1 chats</Text>
            </View>
            <Switch
              value={skipGroupMessages}
              onValueChange={(v) => { setSkipGroupMessages(v); ProTxtSettings?.setSkipGroupMessages?.(v); }}
              trackColor={{ false: BORDER, true: PURPLE + '99' }}
              thumbColor={skipGroupMessages ? PURPLE : MUTED}
            />
          </View>
          <View style={[styles.settingRow, { borderBottomWidth: 0 }]}>
            <View style={{ flex: 1, marginRight: 16 }}>
              <Text style={styles.settingText}>Suggest replies for all messages</Text>
              <Text style={styles.setupStatus}>Off: only when ETA, availability, or plans detected</Text>
            </View>
            <Switch
              value={suggestAllMessages}
              onValueChange={(v) => { setSuggestAllMessagesState(v); ProTxtSettings?.setSuggestAllMessages?.(v); }}
              trackColor={{ false: BORDER, true: PURPLE + '99' }}
              thumbColor={suggestAllMessages ? PURPLE : MUTED}
            />
          </View>
        </View>

        {/* CONTACTS */}
        <Text style={styles.sectionLabel}>CONTACTS</Text>
        <View style={styles.sectionCard}>
          <Pressable style={[styles.settingRow, { borderBottomWidth: 0 }]} onPress={() => setContactsVisible(true)}>
            <View>
              <Text style={styles.settingText}>Manage contacts</Text>
              <Text style={styles.setupStatus}>
                {contacts.length > 0
                  ? `${contacts.length} imported — set tone & relationship`
                  : 'Import and configure contacts'}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        </View>

        {/* ENHANCEMENTS */}
        <Text style={styles.sectionLabel}>ENHANCEMENTS</Text>
        <View style={styles.sectionCard}>
          <View style={styles.settingRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.settingText}>Google Calendar</Text>
              <Text style={styles.setupStatus}>
                {googleAuthed ? 'Connected — availability suggestions on' : 'Sign in to suggest your availability'}
              </Text>
            </View>
            {googleAuthed ? (
              <Pressable onPress={async () => { await signOut(); setGoogleAuthed(false); }}>
                <Text style={styles.setupAction}>Sign out</Text>
              </Pressable>
            ) : (
              <Pressable style={styles.smallButton} onPress={async () => {
                try {
                  await GoogleSignin.hasPlayServices();
                  await GoogleSignin.signIn();
                  setGoogleAuthed(true);
                } catch (err) {
                  Alert.alert('Sign-in error', err instanceof Error ? err.message : 'Sign-in failed');
                }
              }}>
                <Text style={styles.smallButtonText}>Sign in</Text>
              </Pressable>
            )}
          </View>
          <Pressable style={styles.settingRow} onPress={() => setGmailSettingsVisible(true)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.settingText}>Gmail Bookings</Text>
              <Text style={styles.setupStatus}>
                {gmailConnected ? 'Connected — booking lookups on' : 'Connect to look up reservations'}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {gmailConnected && <Text style={[styles.setupStatus, { color: '#4ade80' }]}>✓</Text>}
              <Text style={styles.chevron}>›</Text>
            </View>
          </Pressable>
          <Pressable style={[styles.settingRow, { borderBottomWidth: 0 }]} onPress={() => setMapsSettingsVisible(true)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.settingText}>ETA transport</Text>
              <Text style={styles.setupStatus}>Mode used when someone asks where you are</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={styles.categoryValue}>
                {(enrichmentPrefs.maps?.transportMode ?? 'driving').charAt(0).toUpperCase() + (enrichmentPrefs.maps?.transportMode ?? 'driving').slice(1)}
              </Text>
              <Text style={styles.chevron}>›</Text>
            </View>
          </Pressable>
        </View>

      </ScrollView>

      {/* Contacts modal */}
      <Modal
        visible={contactsVisible}
        transparent
        animationType="slide"
        onRequestClose={() => { setContactsVisible(false); setContactSearch(''); }}
      >
        <Pressable style={styles.modalOverlay} onPress={() => { setContactsVisible(false); setContactSearch(''); }}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <View style={styles.modalHandle} />
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>Contacts</Text>
              <TextInput
                style={styles.searchInput}
                placeholder="Search contacts…"
                placeholderTextColor={MUTED}
                value={contactSearch}
                onChangeText={setContactSearch}
                autoCorrect={false}
              />
              <Text style={styles.modalSection}>IMPORT</Text>
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
                status={whatsappMessages !== null ? `${whatsappMessages} messages` : 'Not imported'}
                done={whatsappMessages !== null}
                loading={setupLoading === 'whatsapp'}
                onPress={handleImportWhatsApp}
              />
              {contacts.length > 0 && <Text style={[styles.modalSection, { marginTop: 16 }]}>PREFERENCES</Text>}
              {contacts.length === 0 ? (
                <Text style={styles.setupHint}>Import contacts above to configure preferences.</Text>
              ) : (() => {
                const shown = contactSearch
                  ? contacts.filter((c) => c.displayName.toLowerCase().includes(contactSearch.toLowerCase()))
                  : contacts.slice(0, 10);
                return (
                  <>
                    {!contactSearch && <Text style={styles.setupHint}>Top 10 by interactions — search for others</Text>}
                    {shown.map((c) => (
                      <View key={c.id} style={styles.contactCard}>
                        <Text style={styles.contactName}>{c.displayName}</Text>
                        <Text style={styles.chipLabel}>Relationship</Text>
                        <View style={styles.chipRow}>
                          {(['friend', 'colleague', 'family', 'partner', 'other'] as Relationship[]).map((r) => (
                            <Pressable
                              key={r}
                              style={[styles.chip, c.relationship === r && styles.chipActive]}
                              onPress={() => updateContactPref(c.id, 'relationship', c.relationship === r ? undefined : r)}
                            >
                              <Text style={[styles.chipText, c.relationship === r && styles.chipTextActive]}>
                                {r.charAt(0).toUpperCase() + r.slice(1)}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                        <Text style={styles.chipLabel}>Preferred tone</Text>
                        <View style={styles.chipRow}>
                          {(['casual', 'formal', 'brief'] as Tone[]).map((t) => (
                            <Pressable
                              key={t}
                              style={[styles.chip, c.preferredTone === t && styles.chipActive]}
                              onPress={() => updateContactPref(c.id, 'preferredTone', c.preferredTone === t ? undefined : t)}
                            >
                              <Text style={[styles.chipText, c.preferredTone === t && styles.chipTextActive]}>
                                {TONE_LABEL[t]}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                      </View>
                    ))}
                    {shown.length === 0 && <Text style={styles.setupHint}>No contacts match "{contactSearch}"</Text>}
                  </>
                );
              })()}
            </ScrollView>
            <Pressable style={styles.modalClose} onPress={() => { setContactsVisible(false); setContactSearch(''); }}>
              <Text style={styles.modalCloseText}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Service settings modal — only reachable when all services already active */}
      <Modal visible={serviceSettingsVisible} transparent animationType="slide" onRequestClose={() => setServiceSettingsVisible(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setServiceSettingsVisible(false)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Service</Text>
            <Pressable
              style={styles.settingRow}
              onPress={() => Linking.sendIntent('android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS').catch(() => {})}
            >
              <View style={styles.settingLeft}>
                <View style={[styles.statusDot, { backgroundColor: notifPermission ? '#4ade80' : '#f87171' }]} />
                <View>
                  <Text style={styles.settingText}>Notification access</Text>
                  <Text style={styles.setupStatus}>{notifPermission ? 'Listening for messages' : 'Tap to enable'}</Text>
                </View>
              </View>
              <Text style={styles.setupAction}>Open</Text>
            </Pressable>
            <Pressable
              style={styles.settingRow}
              onPress={() => ProTxtSettings?.openAccessibilitySettings?.()}
            >
              <View style={styles.settingLeft}>
                <View style={[styles.statusDot, { backgroundColor: accessibilityEnabled ? '#4ade80' : MUTED }]} />
                <View>
                  <Text style={styles.settingText}>Keyboard overlay</Text>
                  <Text style={styles.setupStatus}>{accessibilityEnabled ? 'Active' : 'Off — tap to enable'}</Text>
                </View>
              </View>
              <Text style={styles.setupAction}>Open</Text>
            </Pressable>
            <Pressable
              style={[styles.settingRow, { borderBottomWidth: 0 }]}
              onPress={() => ProTxtSettings?.openAppNotificationSettings?.()}
            >
              <View style={styles.settingLeft}>
                <View style={[styles.statusDot, { backgroundColor: MUTED }]} />
                <View>
                  <Text style={styles.settingText}>Suggestion bubbles</Text>
                  <Text style={styles.setupStatus}>Check {bubbleLabel} is enabled</Text>
                </View>
              </View>
              <Text style={styles.setupAction}>Open</Text>
            </Pressable>
            <Pressable style={styles.modalClose} onPress={() => setServiceSettingsVisible(false)}>
              <Text style={styles.modalCloseText}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Gmail Bookings modal */}
      <Modal visible={gmailSettingsVisible} transparent animationType="slide" onRequestClose={() => setGmailSettingsVisible(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setGmailSettingsVisible(false)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Gmail Bookings</Text>
            <View style={styles.settingRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingText}>{gmailConnected ? 'Gmail connected' : 'Connect Gmail'}</Text>
                <Text style={styles.setupStatus}>{gmailConnected ? 'Booking lookups enabled' : 'Required to look up reservations'}</Text>
              </View>
              {gmailConnected ? (
                <Text style={[styles.setupStatus, { color: '#4ade80', fontWeight: '600' }]}>✓ On</Text>
              ) : (
                <Pressable style={styles.smallButton} onPress={async () => {
                  if (!googleAuthed) { Alert.alert('Sign in first', 'Please sign in with Google Calendar first.'); return; }
                  const ok = await requestGmailScope();
                  if (ok) setGmailConnected(true);
                  else Alert.alert('Permission denied', 'Gmail access is needed to look up your bookings.');
                }}>
                  <Text style={styles.smallButtonText}>Connect</Text>
                </Pressable>
              )}
            </View>
            <Text style={[styles.modalSection, { marginTop: 16 }]}>LOOKBACK PERIOD</Text>
            <View style={styles.chipRow}>
              {(ENRICHMENT_PREFERENCES.bookings ?? []).flatMap((f) => f.options).map((opt) => {
                const active = (enrichmentPrefs.bookings?.lookbackDays ?? '30') === opt.value;
                return (
                  <Pressable key={opt.value} style={[styles.chip, active && styles.chipActive]} onPress={() => {
                    setEnrichmentPrefs((prev) => ({ ...prev, bookings: { ...prev.bookings, lookbackDays: opt.value } }));
                    ProTxtSettings?.setEnrichmentPreference?.('bookings', 'lookbackDays', opt.value);
                  }}>
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Pressable style={styles.modalClose} onPress={() => setGmailSettingsVisible(false)}>
              <Text style={styles.modalCloseText}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ETA transport modal */}
      <Modal visible={mapsSettingsVisible} transparent animationType="slide" onRequestClose={() => setMapsSettingsVisible(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setMapsSettingsVisible(false)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>ETA Transport</Text>
            <Text style={[styles.setupStatus, { marginBottom: 16 }]}>Mode used when calculating your estimated arrival time</Text>
            <View style={styles.chipRow}>
              {(ENRICHMENT_PREFERENCES.maps ?? []).flatMap((f) => f.options).map((opt) => {
                const active = (enrichmentPrefs.maps?.transportMode ?? 'driving') === opt.value;
                return (
                  <Pressable key={opt.value} style={[styles.chip, active && styles.chipActive]} onPress={() => {
                    setEnrichmentPrefs((prev) => ({ ...prev, maps: { ...prev.maps, transportMode: opt.value } }));
                    ProTxtSettings?.setEnrichmentPreference?.('maps', 'transportMode', opt.value);
                  }}>
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Pressable style={styles.modalClose} onPress={() => setMapsSettingsVisible(false)}>
              <Text style={styles.modalCloseText}>Done</Text>
            </Pressable>
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
                  style={[styles.shareInput, { marginBottom: 16 }]}
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
    </SafeAreaProvider>
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
  scroll: { padding: 24, paddingTop: 16, paddingBottom: 48 },

  header: { marginBottom: 28 },
  title: { fontSize: 26, fontWeight: '700', color: TEXT, letterSpacing: -0.5 },
  subtitle: { fontSize: 14, color: MUTED, marginTop: 4 },

  sectionLabel: { fontSize: 11, fontWeight: '600', color: MUTED, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
  sectionCard: { backgroundColor: SURFACE, borderRadius: 14, borderWidth: 1, borderColor: BORDER, marginBottom: 24, overflow: 'hidden' },

  statusDot: { width: 8, height: 8, borderRadius: 4, marginTop: 3 },

  settingRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: BORDER,
  },
  settingLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  settingText: { fontSize: 16, color: TEXT },
  setupStatus: { fontSize: 12, color: MUTED, marginTop: 1 },
  setupAction: { fontSize: 13, color: PURPLE, fontWeight: '600' },
  setupDot: { fontSize: 18, color: MUTED, width: 20, textAlign: 'center' },
  setupDotDone: { color: '#4ade80' },

  chevron: { fontSize: 20, color: MUTED, lineHeight: 22 },
  categoryValue: { fontSize: 14, color: MUTED },

  smallButton: { backgroundColor: PURPLE, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  smallButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: BORDER },
  chipActive: { backgroundColor: PURPLE + '33', borderColor: PURPLE },
  chipText: { color: MUTED, fontSize: 12 },
  chipTextActive: { color: PURPLE, fontWeight: '600' },

  modalOverlay: { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#1c1c1e', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 40, maxHeight: '90%' },
  modalHandle: { width: 36, height: 4, backgroundColor: BORDER, borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: TEXT, marginBottom: 24 },
  modalSection: { fontSize: 11, fontWeight: '600', color: MUTED, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 },
  modalClose: { marginTop: 24, backgroundColor: PURPLE, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  modalCloseText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  searchInput: { backgroundColor: BORDER, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: TEXT, marginBottom: 16 },
  shareInput: { backgroundColor: SURFACE, borderRadius: 14, borderWidth: 1, borderColor: BORDER, padding: 16, fontSize: 16, color: TEXT, minHeight: 80, textAlignVertical: 'top' },

  setupHint: { color: MUTED, fontSize: 12, marginBottom: 12 },

  contactCard: { paddingVertical: 12, paddingHorizontal: 0, borderBottomWidth: 1, borderBottomColor: BORDER },
  contactName: { color: TEXT, fontSize: 14, fontWeight: '600', marginBottom: 8 },
  chipLabel: { color: MUTED, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 },
});
