import AsyncStorage from '@react-native-async-storage/async-storage';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Linking,
  Modal,
  NativeModules,
  PermissionsAndroid,
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
import HomeScreen from './src/screens/HomeScreen';
import FollowUpsScreen from './src/screens/FollowUpsScreen';
import ContactDetailModal from './src/screens/ContactDetailModal';
import UpcomingScreen from './src/screens/UpcomingScreen';
import HomeLocationConfirmModal from './src/screens/HomeLocationConfirmModal';
import type { HomeCandidate } from './src/screens/HomeLocationConfirmModal';
import { loadUpcomingEvents, PLATFORM_ICONS, UPCOMING_EMPTY } from './src/services/upcomingEvents';
import type { UpcomingData } from './src/services/upcomingEvents';
import { loadFollowUps, addFollowUp } from './src/services/followUps';
import type { FollowUp } from './src/services/followUps';
import { loadPendingCalendarActions } from './src/services/pendingCalendarActions';
import type { PendingCalendarAction } from './src/services/pendingCalendarActions';
import { loadPendingFollowUps, drainConfirmedFollowUps } from './src/services/pendingFollowUps';
import type { PendingFollowUp } from './src/services/pendingFollowUps';

const { ProTxtSettings } = NativeModules;

import { suggestReply } from './src/services/claude';
import { addEntitlementListener, checkProEntitlement, configurePurchases, fetchOfferings, presentCustomerCenter, purchasePkg, restorePurchases } from './src/services/purchases';
import type { PurchasesOfferings, PurchasesPackage } from 'react-native-purchases';
import { getAllContacts, getConfirmedPlatformIdentities, updateContactPreferences, upsertContact } from './src/services/database';
import { importDeviceContacts } from './src/services/deviceContacts';
import { configureGoogleSignin, initAuth, isSignedIn, signOut } from './src/services/googleAuth';
import { getCalendarData } from './src/services/googleCalendar';
import { getBookingsContext } from './src/services/googleBookings';
import { getEtaData } from './src/services/googleMaps';
import { importGoogleContacts } from './src/services/googlePeople';
import { refreshContactListCache, syncStyleProfile } from './src/services/styleSync';
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

type Tab = 'home' | 'followups' | 'upcoming' | 'settings';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [pendingCalendarActions, setPendingCalendarActions] = useState<PendingCalendarAction[]>([]);
  const [pendingFollowUps, setPendingFollowUps] = useState<PendingFollowUp[]>([]);
  const [defaultTone, setDefaultToneState] = useState<Tone>('casual');
  const [googleAuthed, setGoogleAuthed] = useState(false);
  const [notifPermission, setNotifPermission] = useState(false);
  const [locationGranted, setLocationGranted] = useState(false);
  const [backgroundLocationGranted, setBackgroundLocationGranted] = useState(false);
  const [bubblesEnabled, setBubblesEnabled] = useState(false);
  const [accessibilityEnabled, setAccessibilityEnabled] = useState(false);
  const [bubbleLabel, setBubbleLabel] = useState('Notifications → Bubbles');
  const [styleStats, setStyleStats] = useState<{ editCount: number; contactsMatched: number; hasProfile: boolean } | null>(null);
  const [googleContactsCount, setGoogleContactsCount] = useState<number | null>(null);
  const [deviceContactsCount, setDeviceContactsCount] = useState<number | null>(null);
  const [whatsappMessages, setWhatsappMessages] = useState<number | null>(null);
  const [setupLoading, setSetupLoading] = useState<string | null>(null);
  const [skipGroupMessages, setSkipGroupMessages] = useState(false);
  const [remindersEnabled, setRemindersEnabledState] = useState(true);
  const [suggestAllMessages, setSuggestAllMessagesState] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactPlatforms, setContactPlatforms] = useState<Record<string, string[]>>({});
  const [contactsVisible, setContactsVisible] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [newContactVisible, setNewContactVisible] = useState(false);
  const [newContactName, setNewContactName] = useState('');
  const [newContactRelationship, setNewContactRelationship] = useState<Relationship | undefined>(undefined);
  const [newContactTone, setNewContactTone] = useState<Tone | undefined>(undefined);
  const [newContactSaving, setNewContactSaving] = useState(false);
  const [enrichmentPrefs, setEnrichmentPrefs] = useState<Record<string, Record<string, string>>>({});
  const [gmailSettingsVisible, setGmailSettingsVisible] = useState(false);
  const [mapsSettingsVisible, setMapsSettingsVisible] = useState(false);
  const [keyboardDefault, setKeyboardDefault] = useState(false);
  const [isPro, setIsPro] = useState(false);
  const [paywallVisible, setPaywallVisible] = useState(false);
  const [paywallOfferings, setPaywallOfferings] = useState<PurchasesOfferings | null>(null);
  const [paywallFetchDone, setPaywallFetchDone] = useState(false);
  const [paywallSelectedPkg, setPaywallSelectedPkg] = useState<PurchasesPackage | null>(null);
  const [paywallLoading, setPaywallLoading] = useState(false);
  const [paywallRestoring, setPaywallRestoring] = useState(false);
  const [paywallError, setPaywallError] = useState<string | null>(null);
  const [shareText, setShareText] = useState<string | null>(null);
  const [shareReply, setShareReply] = useState('');
  const [shareLoading, setShareLoading] = useState(false);
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [upcomingData, setUpcomingData] = useState<UpcomingData>(UPCOMING_EMPTY);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [savedHome, setSavedHome] = useState<HomeCandidate | null>(null);
  const [homeCandidate, setHomeCandidate] = useState<HomeCandidate | null>(null);

  useEffect(() => {
    if (contactsVisible) {
      getAllContacts().then(setContacts).catch(() => {});
      // One bulk query grouped client-side, rather than one platform-identities
      // lookup per row — the list can show dozens of contacts at once. Merges
      // in native confirmed_identities links too — the much more common
      // automatic "Is this X?" banner path has only ever written there, never
      // to the platform_identities table, so most real links wouldn't show
      // up here without this (see ContactDetailModal's backfillConfirmedLinks
      // for the same gap, and why it's fixed on read rather than migrated).
      Promise.all([
        getConfirmedPlatformIdentities(),
        ProTxtSettings?.getAllConfirmedLinks?.().then((json: string) => JSON.parse(json)).catch(() => [] as { contactId: string; platform: string }[]),
      ]).then(([ids, links]) => {
        const grouped: Record<string, string[]> = {};
        for (const id of ids) {
          if (id.identifierType === 'display_name') continue;
          const list = grouped[id.contactId] ?? (grouped[id.contactId] = []);
          if (!list.includes(id.platform)) list.push(id.platform);
        }
        for (const link of links as { contactId: string; platform: string }[]) {
          const list = grouped[link.contactId] ?? (grouped[link.contactId] = []);
          if (!list.includes(link.platform)) list.push(link.platform);
        }
        setContactPlatforms(grouped);
      }).catch(() => {});
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
    }).catch(() => setSetupComplete(false));
    configureGoogleSignin();
    initAuth().then(() => setGoogleAuthed(isSignedIn()));
    if (Platform.OS === 'android' && ProTxtSettings) {
      ProTxtSettings.isNlsConnected().then((ok: boolean) => setNotifPermission(ok)).catch(() => {});
      PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION).then(setLocationGranted).catch(() => {});
      if ((Platform.Version as number) >= 29) {
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION).then(setBackgroundLocationGranted).catch(() => {});
      } else {
        setBackgroundLocationGranted(true); // permission doesn't exist pre-Android 10 — nothing to check
      }
      ProTxtSettings.areBubblesEnabled?.().then((ok: boolean) => setBubblesEnabled(ok)).catch(() => {});
      ProTxtSettings.isAccessibilityServiceEnabled().then((ok: boolean) => setAccessibilityEnabled(ok)).catch(() => {});
      ProTxtSettings.isConTxtKeyboardDefault().then((ok: boolean) => setKeyboardDefault(ok)).catch(() => {});
      ProTxtSettings.getSkipGroupMessages().then((skip: boolean) => setSkipGroupMessages(skip)).catch(() => {});
      ProTxtSettings.getRemindersEnabled?.().then((v: boolean) => setRemindersEnabledState(v)).catch(() => {});
      ProTxtSettings.getSuggestAllMessages().then((all: boolean) => setSuggestAllMessagesState(all)).catch(() => {});
      ProTxtSettings.getBubbleSettingsLabel().then((label: string) => setBubbleLabel(label)).catch(() => {});
      ProTxtSettings.getStyleStats?.().then((json: string) => setStyleStats(JSON.parse(json))).catch(() => {});
      Promise.all(
        Object.entries(ENRICHMENT_PREFERENCES).map(async ([enrichment, fields]) => {
          const entries = await Promise.all(
            (fields ?? []).map(async (field) => {
              const val = await ProTxtSettings.getEnrichmentPreference(enrichment, field.key).catch(() => null);
              return [field.key, val ?? field.defaultValue] as const;
            })
          );
          return [enrichment, Object.fromEntries(entries)] as const;
        })
      ).then((results) => setEnrichmentPrefs(Object.fromEntries(results)))
       .catch(() => {});
      ProTxtSettings.getSharedText().then((text: string | null) => {
        if (text) { setShareText(text); setShareReply(''); }
      }).catch(() => {});
      ProTxtSettings.getSavedHome?.().then((json: string | null) => setSavedHome(json ? JSON.parse(json) : null)).catch(() => {});
      ProTxtSettings.getPendingHomeCandidate?.().then((json: string | null) => {
        if (json) setHomeCandidate(JSON.parse(json));
      }).catch(() => {});
      syncStyleProfile();
    }
    configurePurchases();
    checkProEntitlement().then(setIsPro);
    loadFollowUps().then(setFollowUps).catch(() => {});
    loadPendingCalendarActions().then(setPendingCalendarActions).catch(() => {});
    loadPendingFollowUps().then(setPendingFollowUps).catch(() => {});
    drainConfirmedFollowUps().then(confirmed => {
      if (confirmed.length === 0) return;
      Promise.all(confirmed.map(c => addFollowUp({ text: c.task, contactName: c.contactName ?? undefined })))
        .then(results => { if (results.length) setFollowUps(results[results.length - 1]); })
        .catch(() => {});
    }).catch(() => {});
  }, []);


  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || Platform.OS !== 'android' || !ProTxtSettings) return;
      ProTxtSettings.isNlsConnected().then((ok: boolean) => setNotifPermission(ok)).catch(() => {});
      PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION).then(setLocationGranted).catch(() => {});
      if ((Platform.Version as number) >= 29) {
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION).then(setBackgroundLocationGranted).catch(() => {});
      } else {
        setBackgroundLocationGranted(true); // permission doesn't exist pre-Android 10 — nothing to check
      }
      ProTxtSettings.areBubblesEnabled?.().then((ok: boolean) => setBubblesEnabled(ok)).catch(() => {});
      ProTxtSettings.isAccessibilityServiceEnabled().then((ok: boolean) => setAccessibilityEnabled(ok)).catch(() => {});
      ProTxtSettings.isConTxtKeyboardDefault().then((ok: boolean) => setKeyboardDefault(ok)).catch(() => {});
      ProTxtSettings.getSharedText().then((text: string | null) => {
        if (text) { setShareText(text); setShareReply(''); }
      }).catch(() => {});
      ProTxtSettings.getPendingHomeCandidate?.().then((json: string | null) => {
        if (json) setHomeCandidate(JSON.parse(json));
      }).catch(() => {});
      ProTxtSettings.refreshBubbleState?.();
      loadPendingCalendarActions().then(setPendingCalendarActions).catch(() => {});
      loadPendingFollowUps().then(setPendingFollowUps).catch(() => {});
      drainConfirmedFollowUps().then(confirmed => {
        if (confirmed.length === 0) return;
        Promise.all(confirmed.map(c => addFollowUp({ text: c.task, contactName: c.contactName ?? undefined })))
          .then(results => { if (results.length) setFollowUps(results[results.length - 1]); })
          .catch(() => {});
      }).catch(() => {});
      loadUpcomingEvents(googleAuthed, setUpcomingData).catch(() => {});
    });
    const removeEntitlementListener = addEntitlementListener(setIsPro);
    return () => { sub.remove(); removeEntitlementListener(); };
  }, [googleAuthed]);

  useEffect(() => {
    if (!googleAuthed) return;
    loadUpcomingEvents(googleAuthed).then(setUpcomingData).catch(() => {});
  }, [googleAuthed]);

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
            if (key === 'bookings' && googleAuthed) enrichments.bookings = await getBookingsContext(Number(enrichmentPrefs.bookings?.lookbackDays ?? 30));
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
    refreshContactListCache().catch(() => {});
  };

  const saveDefaultTone = async (t: Tone) => {
    setDefaultToneState(t);
    await AsyncStorage.setItem(DEFAULT_TONE_KEY, t);
    NativeModules.ProTxtSettings?.setDefaultTone?.(t);
  };

  const handleImportGoogleContacts = async () => {
    if (!googleAuthed) { Alert.alert('Not signed in', 'Please sign in with Google first.'); return; }
    setSetupLoading('google');
    try {
      const count = await importGoogleContacts();
      setGoogleContactsCount(count);
      await AsyncStorage.setItem(GOOGLE_CONTACTS_COUNT_KEY, String(count));
      refreshContactListCache().catch(() => {});
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
      refreshContactListCache().catch(() => {});
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

  const openPaywall = async () => {
    setPaywallError(null);
    setPaywallSelectedPkg(null);
    setPaywallOfferings(null);
    setPaywallFetchDone(false);
    setPaywallVisible(true);
    const offerings = await fetchOfferings();
    setPaywallOfferings(offerings);
    setPaywallFetchDone(true);
    // Fall back to any available package across all offerings if current is unset
    const pkgs = offerings?.current?.availablePackages?.length
      ? offerings.current.availablePackages
      : Object.values(offerings?.all ?? {}).flatMap((o) => o.availablePackages ?? []);
    if (pkgs.length > 0) setPaywallSelectedPkg(pkgs[pkgs.length - 1]);
  };

  const handlePurchase = async () => {
    if (!paywallSelectedPkg) return;
    setPaywallLoading(true);
    setPaywallError(null);
    try {
      const granted = await purchasePkg(paywallSelectedPkg);
      if (granted) {
        setIsPro(true);
        setSuggestAllMessagesState(true);
        ProTxtSettings?.setSuggestAllMessages?.(true);
        setPaywallVisible(false);
      }
    } catch (e: any) {
      if (!e?.userCancelled) setPaywallError('Purchase failed. Please try again.');
    } finally {
      setPaywallLoading(false);
    }
  };

  const handleRestore = async () => {
    setPaywallRestoring(true);
    setPaywallError(null);
    try {
      const granted = await restorePurchases();
      if (granted) {
        setIsPro(true);
        setSuggestAllMessagesState(true);
        ProTxtSettings?.setSuggestAllMessages?.(true);
        setPaywallVisible(false);
      } else {
        setPaywallError('No previous purchase found.');
      }
    } catch {
      setPaywallError('Restore failed. Please try again.');
    } finally {
      setPaywallRestoring(false);
    }
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

      {/* Tab content */}
      {activeTab === 'home' && (
        <HomeScreen
          followUps={followUps}
          pendingCalendarActions={pendingCalendarActions}
          pendingFollowUps={pendingFollowUps}
          upcomingData={upcomingData}
          styleStats={styleStats}
          onCalendarActionDismiss={(id) => setPendingCalendarActions(prev => prev.filter(a => a.id !== id))}
          onFollowUpAdd={(item) => {
            setPendingFollowUps(prev => prev.filter(f => f.id !== item.id));
            addFollowUp({ text: item.task, contactName: item.contactName ?? undefined })
              .then(setFollowUps).catch(() => {});
          }}
          onFollowUpDismiss={(id) => setPendingFollowUps(prev => prev.filter(f => f.id !== id))}
          onGoToFollowUps={() => setActiveTab('followups')}
          onGoToSettings={() => setActiveTab('settings')}
          onOpenPaywall={openPaywall}
          isPro={isPro}
          missingPermissions={[
            !notifPermission && 'Notification access',
            !bubblesEnabled && 'Suggestion bubbles',
            (Platform.Version as number) >= 29 && !backgroundLocationGranted && 'Background location',
          ].filter((v): v is string => typeof v === 'string')}
        />
      )}
      {activeTab === 'followups' && (
        <FollowUpsScreen followUps={followUps} setFollowUps={setFollowUps} />
      )}
      {activeTab === 'upcoming' && (
        <UpcomingScreen
          upcomingData={upcomingData}
          googleAuthed={googleAuthed}
          onGoToSettings={() => setActiveTab('settings')}
        />
      )}
      {activeTab === 'settings' && (
      <ScrollView style={styles.flex} contentContainerStyle={styles.scroll}>

        <View style={styles.header}>
          <Text style={styles.title}>Settings</Text>
          <Text style={styles.subtitle}>Reply suggestions in the background</Text>
        </View>

        {/* ACCOUNT */}
        <Text style={styles.sectionLabel}>ACCOUNT</Text>
        <View style={styles.sectionCard}>
          <View style={styles.settingRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.settingText}>Google account</Text>
              <Text style={styles.setupStatus}>
                {googleAuthed ? 'Connected — Calendar availability & Gmail bookings enabled' : 'Sign in to enable availability suggestions & booking lookups'}
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
          <Pressable
            style={styles.settingRow}
            onPress={() => {
              if (!savedHome) return;
              Alert.alert('Change home location', 'This clears the saved home so it can be detected again overnight.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Clear', style: 'destructive', onPress: () => { ProTxtSettings?.clearSavedHome?.(); setSavedHome(null); } },
              ]);
            }}
          >
            <View style={styles.settingLeft}>
              <View style={[styles.statusDot, { backgroundColor: savedHome ? '#4ade80' : MUTED }]} />
              <View>
                <Text style={styles.settingText}>Home location</Text>
                <Text style={styles.setupStatus} numberOfLines={1}>
                  {savedHome ? (savedHome.area ?? 'Saved') : 'Not detected yet — checked overnight'}
                </Text>
              </View>
            </View>
            {savedHome && <Text style={styles.setupAction}>Change</Text>}
          </Pressable>
          {isPro ? (
            <Pressable style={[styles.settingRow, { borderBottomWidth: 0 }]} onPress={() => presentCustomerCenter()}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingText}>ConTxt Pro</Text>
                <Text style={styles.setupStatus}>Active</Text>
              </View>
              <Text style={styles.setupAction}>Manage ›</Text>
            </Pressable>
          ) : (
            <Pressable style={[styles.settingRow, { borderBottomWidth: 0 }]} onPress={() => openPaywall()}>
              <View style={{ flex: 1, marginRight: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={[styles.settingText, { flexShrink: 1 }]}>ConTxt Pro</Text>
                  <View style={[styles.proBadge, { flexShrink: 0 }]}>
                    <Text style={styles.proBadgeText}>PRO</Text>
                  </View>
                </View>
                <Text style={styles.setupStatus}>Free plan — upgrade for tone control & more</Text>
              </View>
              <Text style={styles.setupAction}>Upgrade ›</Text>
            </Pressable>
          )}
        </View>

        {/* PERMISSIONS */}
        <Text style={styles.sectionLabel}>PERMISSIONS</Text>
        <View style={styles.sectionCard}>
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
            onPress={async () => {
              const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
              setLocationGranted(result === PermissionsAndroid.RESULTS.GRANTED);
            }}
          >
            <View style={styles.settingLeft}>
              <View style={[styles.statusDot, { backgroundColor: locationGranted ? '#4ade80' : '#f87171' }]} />
              <View>
                <Text style={styles.settingText}>Location</Text>
                <Text style={styles.setupStatus}>{locationGranted ? 'Enabled — used for ETA suggestions' : 'Tap to enable'}</Text>
              </View>
            </View>
            {!locationGranted && <Text style={styles.setupAction}>Open</Text>}
          </Pressable>
          {locationGranted && (Platform.Version as number) >= 29 && (
            <Pressable
              style={styles.settingRow}
              onPress={() => ProTxtSettings?.openAppLocationSettings?.() ?? Linking.openSettings()}
            >
              <View style={styles.settingLeft}>
                <View style={[styles.statusDot, { backgroundColor: backgroundLocationGranted ? '#4ade80' : '#f87171' }]} />
                <View>
                  <Text style={styles.settingText}>Background location</Text>
                  <Text style={styles.setupStatus}>
                    {backgroundLocationGranted ? 'Enabled — ETA works when the app is closed' : 'Needed for ETA replies while the app is closed — tap, then choose "Allow all the time"'}
                  </Text>
                </View>
              </View>
              {!backgroundLocationGranted && <Text style={styles.setupAction}>Open</Text>}
            </Pressable>
          )}
          <Pressable
            style={[styles.settingRow, { borderBottomWidth: 0 }]}
            onPress={() => ProTxtSettings?.openAccessibilitySettings?.()}
          >
            <View style={styles.settingLeft}>
              <View style={[styles.statusDot, { backgroundColor: accessibilityEnabled ? '#4ade80' : MUTED }]} />
              <View>
                <Text style={styles.settingText}>Keyboard overlay <Text style={{ color: MUTED, fontSize: 11 }}>beta</Text></Text>
                <Text style={styles.setupStatus}>{accessibilityEnabled ? 'Active' : 'Off — tap to enable'}</Text>
              </View>
            </View>
            {!accessibilityEnabled && <Text style={styles.setupAction}>Enable</Text>}
          </Pressable>
        </View>

        {/* REPLY SURFACES */}
        <Text style={styles.sectionLabel}>REPLY SURFACES</Text>
        <View style={styles.sectionCard}>
          <Pressable
            style={styles.settingRow}
            onPress={() => ProTxtSettings?.openAppNotificationSettings?.()}
          >
            <View style={styles.settingLeft}>
              <View style={[styles.statusDot, { backgroundColor: bubblesEnabled ? '#4ade80' : '#f87171' }]} />
              <View>
                <Text style={styles.settingText}>Suggestion bubbles</Text>
                <Text style={styles.setupStatus}>
                  {bubblesEnabled ? 'Enabled' : `Off — enable under ${bubbleLabel}`}
                </Text>
              </View>
            </View>
            {!bubblesEnabled && <Text style={styles.setupAction}>Open</Text>}
          </Pressable>
          <Pressable
            style={[styles.settingRow, { borderBottomWidth: 0 }]}
            onPress={() => ProTxtSettings?.openInputMethodSettings?.()}
          >
            <View style={styles.settingLeft}>
              <View style={[styles.statusDot, { backgroundColor: keyboardDefault ? '#4ade80' : MUTED }]} />
              <View>
                <Text style={styles.settingText}>ConTxt Keyboard <Text style={{ color: MUTED, fontSize: 11 }}>beta</Text></Text>
                <Text style={styles.setupStatus}>{keyboardDefault ? 'Active' : 'Install keyboard APK then set as default'}</Text>
              </View>
            </View>
            {!keyboardDefault && <Text style={styles.setupAction}>Set up</Text>}
          </Pressable>
        </View>

        {/* REPLY PREFERENCES */}
        <Text style={styles.sectionLabel}>REPLY PREFERENCES</Text>
        <View style={styles.sectionCard}>
          <Pressable style={styles.settingRow} onPress={() => { if (!isPro) openPaywall(); }} disabled={isPro}>
            <View style={{ flex: 1, marginRight: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={styles.settingText}>Default tone</Text>
                {!isPro && (
                  <View style={styles.proBadge}>
                    <Text style={styles.proBadgeText}>PRO</Text>
                  </View>
                )}
              </View>
              <Text style={styles.setupStatus}>Casual, formal, brief — with reply strategy</Text>
            </View>
            {isPro ? (
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
            ) : (
              <Text style={styles.setupAction}>Upgrade ›</Text>
            )}
          </Pressable>
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
          <View style={styles.settingRow}>
            <View style={{ flex: 1, marginRight: 16 }}>
              <Text style={styles.settingText}>Reply reminders</Text>
              <Text style={styles.setupStatus}>Notify you with a suggested reply if you haven't responded</Text>
            </View>
            <Switch
              value={remindersEnabled}
              onValueChange={(v) => { setRemindersEnabledState(v); ProTxtSettings?.setRemindersEnabled?.(v); }}
              trackColor={{ false: BORDER, true: PURPLE + '99' }}
              thumbColor={remindersEnabled ? PURPLE : MUTED}
            />
          </View>
          <Pressable style={[styles.settingRow, { borderBottomWidth: 0 }]} onPress={() => { if (!isPro) openPaywall(); }} disabled={isPro}>
            <View style={{ flex: 1, marginRight: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={styles.settingText}>Suggest replies for all messages</Text>
                {!isPro && (
                  <View style={styles.proBadge}>
                    <Text style={styles.proBadgeText}>PRO</Text>
                  </View>
                )}
              </View>
              <Text style={styles.setupStatus}>
                {isPro ? 'Suggesting replies for every incoming message' : 'Upgrade to suggest replies for every message'}
              </Text>
            </View>
            {isPro ? (
              <Switch
                value={suggestAllMessages}
                onValueChange={(v) => {
                  setSuggestAllMessagesState(v);
                  ProTxtSettings?.setSuggestAllMessages?.(v);
                }}
                trackColor={{ false: BORDER, true: PURPLE + '99' }}
                thumbColor={suggestAllMessages ? PURPLE : MUTED}
              />
            ) : (
              <Text style={styles.setupAction}>Upgrade ›</Text>
            )}
          </Pressable>
        </View>

        {/* ENRICHMENT SOURCES */}
        <Text style={styles.sectionLabel}>ENRICHMENT SOURCES</Text>
        <View style={styles.sectionCard}>
          <Pressable style={styles.settingRow} onPress={() => setGmailSettingsVisible(true)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.settingText}>Gmail Bookings</Text>
              <Text style={styles.setupStatus}>
                {googleAuthed ? 'Booking lookups on' : 'Requires Google account above'}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {googleAuthed && <Text style={[styles.setupStatus, { color: '#4ade80' }]}>✓</Text>}
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

      </ScrollView>
      )}

      {/* Bottom navigation */}
      <View style={styles.bottomNav}>
        {([
          { key: 'home',      icon: '⌂',  label: 'Home'      },
          { key: 'followups', icon: '☑',  label: 'Follow-ups' },
          { key: 'upcoming',  icon: '🗓',  label: 'Upcoming'  },
          { key: 'settings',  icon: '⚙',  label: 'Settings'  },
        ] as { key: Tab; icon: string; label: string }[]).map(tab => {
          const active = activeTab === tab.key;
          const overdueCount = tab.key === 'followups' ? followUps.filter(f => f.status === 'pending' && f.dueAt != null && f.dueAt < Date.now()).length : 0;
          return (
            <Pressable key={tab.key} style={styles.navItem} onPress={() => {
              if (tab.key === 'home') {
                loadPendingCalendarActions().then(setPendingCalendarActions).catch(() => {});
                loadPendingFollowUps().then(setPendingFollowUps).catch(() => {});
              }
              if (tab.key === 'upcoming') {
                loadUpcomingEvents(googleAuthed, setUpcomingData).catch(() => {});
              }
              setActiveTab(tab.key);
            }}>
              <View>
                <Text style={[styles.navIcon, active && styles.navIconActive]}>{tab.icon}</Text>
                {overdueCount > 0 && <View style={styles.navBadge}><Text style={styles.navBadgeText}>{overdueCount}</Text></View>}
              </View>
              <Text style={[styles.navLabel, active && styles.navLabelActive]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>

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
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
                <Text style={[styles.modalTitle, { marginBottom: 0 }]}>Contacts</Text>
                <Pressable
                  style={styles.smallButton}
                  onPress={() => {
                    setNewContactName('');
                    setNewContactRelationship(undefined);
                    setNewContactTone(undefined);
                    setNewContactVisible(true);
                  }}
                >
                  <Text style={styles.smallButtonText}>+ New</Text>
                </Pressable>
              </View>
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
                        <Pressable onPress={() => setSelectedContactId(c.id)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 12 }}>
                            <Text style={styles.contactName} numberOfLines={1}>{c.displayName}</Text>
                            {(contactPlatforms[c.id]?.length ?? 0) > 0 && (
                              <View style={{ flexDirection: 'row', marginLeft: 8, gap: 3 }}>
                                {contactPlatforms[c.id].map((p) => (
                                  <Text key={p} style={{ fontSize: 12 }}>{PLATFORM_ICONS[p] ?? '📱'}</Text>
                                ))}
                              </View>
                            )}
                          </View>
                          <Text style={{ fontSize: 12, color: '#6366f1' }}>View profile</Text>
                        </Pressable>
                        <Text style={styles.chipLabel}>Relationship</Text>
                        <View style={styles.chipRow}>
                          {(['friend', 'colleague', 'family', 'partner', 'flatmate', 'other'] as Relationship[]).map((r) => (
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

      {/* Contact detail modal */}
      <ContactDetailModal
        contactId={selectedContactId}
        onClose={() => setSelectedContactId(null)}
        onPreferenceChange={(id, relationship, preferredTone) => {
          setContacts(prev => prev.map(c => c.id === id ? { ...c, relationship, preferredTone } : c));
          syncStyleProfile();
          refreshContactListCache().catch(() => {});
        }}
      />

      {/* Home location review — visual confirm before saving */}
      <HomeLocationConfirmModal
        candidate={homeCandidate}
        onConfirm={(candidate) => {
          ProTxtSettings?.confirmHomeLocation?.(candidate.lat, candidate.lon, candidate.area ?? null);
          setSavedHome(candidate);
          setHomeCandidate(null);
        }}
        onDismiss={() => {
          ProTxtSettings?.dismissHomeCandidate?.();
          setHomeCandidate(null);
        }}
      />


      {/* Gmail Bookings modal */}
      <Modal visible={gmailSettingsVisible} transparent animationType="slide" onRequestClose={() => setGmailSettingsVisible(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setGmailSettingsVisible(false)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Gmail Bookings</Text>
            <View style={styles.settingRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingText}>{googleAuthed ? 'Gmail connected' : 'Sign in with Google'}</Text>
                <Text style={styles.setupStatus}>{googleAuthed ? 'Booking lookups enabled' : 'Sign in with Google in Settings to enable'}</Text>
              </View>
              {googleAuthed && <Text style={[styles.setupStatus, { color: '#4ade80', fontWeight: '600' }]}>✓ On</Text>}
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

      {/* New contact modal */}
      <Modal
        visible={newContactVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setNewContactVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setNewContactVisible(false)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>New Contact</Text>
            <Text style={styles.modalSection}>NAME</Text>
            <TextInput
              style={[styles.searchInput, { marginBottom: 20 }]}
              placeholder="Display name…"
              placeholderTextColor={MUTED}
              value={newContactName}
              onChangeText={setNewContactName}
              autoCorrect={false}
              autoCapitalize="words"
            />
            <Text style={styles.modalSection}>RELATIONSHIP</Text>
            <View style={[styles.chipRow, { marginBottom: 20 }]}>
              {(['friend', 'colleague', 'family', 'partner', 'flatmate', 'other'] as Relationship[]).map((r) => (
                <Pressable
                  key={r}
                  style={[styles.chip, newContactRelationship === r && styles.chipActive]}
                  onPress={() => setNewContactRelationship(newContactRelationship === r ? undefined : r)}
                >
                  <Text style={[styles.chipText, newContactRelationship === r && styles.chipTextActive]}>
                    {r.charAt(0).toUpperCase() + r.slice(1)}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.modalSection}>PREFERRED TONE</Text>
            <View style={[styles.chipRow, { marginBottom: 8 }]}>
              {(['casual', 'formal', 'brief'] as Tone[]).map((t) => (
                <Pressable
                  key={t}
                  style={[styles.chip, newContactTone === t && styles.chipActive]}
                  onPress={() => setNewContactTone(newContactTone === t ? undefined : t)}
                >
                  <Text style={[styles.chipText, newContactTone === t && styles.chipTextActive]}>
                    {TONE_LABEL[t]}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <Pressable
                style={[styles.modalClose, { flex: 1, backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER }]}
                onPress={() => setNewContactVisible(false)}
              >
                <Text style={[styles.modalCloseText, { color: MUTED }]}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalClose, { flex: 2, opacity: newContactName.trim().length === 0 || newContactSaving ? 0.5 : 1 }]}
                disabled={newContactName.trim().length === 0 || newContactSaving}
                onPress={async () => {
                  const name = newContactName.trim();
                  if (!name) return;
                  setNewContactSaving(true);
                  try {
                    const created = await upsertContact({
                      displayName: name,
                      relationship: newContactRelationship,
                      preferredTone: newContactTone,
                    });
                    setContacts((prev) => [created, ...prev]);
                    syncStyleProfile();
                    setNewContactVisible(false);
                  } finally {
                    setNewContactSaving(false);
                  }
                }}
              >
                <Text style={styles.modalCloseText}>{newContactSaving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Paywall modal */}
      <Modal visible={paywallVisible} transparent animationType="slide" onRequestClose={() => setPaywallVisible(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setPaywallVisible(false)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <View style={styles.modalHandle} />

            <View style={{ alignItems: 'center', marginBottom: 20 }}>
              <Image
                source={require('./assets/contxt-logo-g-minimal-circuit.png')}
                style={{ width: 64, height: 64, borderRadius: 16, marginBottom: 12 }}
              />
              <Text style={[styles.modalTitle, { textAlign: 'center', marginBottom: 4 }]}>ConTxt Pro</Text>
              <Text style={[styles.setupStatus, { textAlign: 'center' }]}>Reply smarter, to every message</Text>
            </View>

            <View style={styles.paywallFeatureList}>
              {[
                'Suggestions for every incoming message',
                'Not just ETA, availability, or plans',
                'First access to new Pro features',
              ].map((f) => (
                <View key={f} style={styles.paywallFeatureRow}>
                  <Text style={styles.paywallFeatureCheck}>✓</Text>
                  <Text style={styles.paywallFeatureText}>{f}</Text>
                </View>
              ))}
            </View>

            {/* Package selection */}
            {!paywallFetchDone ? (
              <ActivityIndicator color={PURPLE} style={{ marginVertical: 24 }} />
            ) : (paywallOfferings?.current?.availablePackages?.length ?? 0) === 0 &&
                Object.values(paywallOfferings?.all ?? {}).flatMap((o) => o.availablePackages ?? []).length === 0 ? (
              <View style={{ alignItems: 'center', marginVertical: 24, gap: 12 }}>
                <Text style={[styles.setupStatus, { textAlign: 'center' }]}>
                  Pricing not available right now.
                </Text>
                <Pressable onPress={openPaywall} style={{ paddingVertical: 8, paddingHorizontal: 20, borderRadius: 8, borderWidth: 1, borderColor: PURPLE }}>
                  <Text style={{ color: PURPLE, fontSize: 14 }}>Try again</Text>
                </Pressable>
              </View>
            ) : (
              <View style={{ gap: 10, marginVertical: 20 }}>
                {(paywallOfferings?.current?.availablePackages?.length
                  ? paywallOfferings.current.availablePackages
                  : Object.values(paywallOfferings?.all ?? {}).flatMap((o) => o.availablePackages ?? [])
                ).map((pkg) => {
                  const selected = paywallSelectedPkg?.identifier === pkg.identifier;
                  const isAnnual = pkg.packageType === 'ANNUAL' || pkg.identifier.toLowerCase().includes('annual');
                  return (
                    <Pressable
                      key={pkg.identifier}
                      style={[styles.paywallPkgCard, selected && styles.paywallPkgCardSelected]}
                      onPress={() => setPaywallSelectedPkg(pkg)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.paywallPkgName, selected && { color: TEXT }]}>
                          {(pkg.product.title || '').replace(/\s*\([^)]*\)\s*$/, '').trim() || (isAnnual ? 'Annual' : 'Monthly')}
                        </Text>
                        <Text style={[styles.setupStatus, { marginTop: 1 }]}>
                          {pkg.product.priceString}{isAnnual ? ' / year' : ' / month'}
                        </Text>
                      </View>
                      {isAnnual && (
                        <View style={styles.paywallBestValue}>
                          <Text style={styles.paywallBestValueText}>Best value</Text>
                        </View>
                      )}
                      <View style={[styles.paywallRadio, selected && styles.paywallRadioSelected]}>
                        {selected && <View style={styles.paywallRadioDot} />}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}

            {paywallError && (
              <Text style={{ color: '#f87171', fontSize: 13, textAlign: 'center', marginBottom: 12 }}>{paywallError}</Text>
            )}

            <Pressable
              style={[styles.modalClose, { opacity: paywallLoading || !paywallSelectedPkg ? 0.6 : 1 }]}
              onPress={handlePurchase}
              disabled={paywallLoading || !paywallSelectedPkg}
            >
              {paywallLoading
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.modalCloseText}>Subscribe</Text>}
            </Pressable>

            <Pressable onPress={handleRestore} disabled={paywallRestoring} style={{ marginTop: 16, alignItems: 'center' }}>
              <Text style={{ color: MUTED, fontSize: 13 }}>
                {paywallRestoring ? 'Restoring…' : 'Restore purchases'}
              </Text>
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

  bottomNav:     { flexDirection: 'row', backgroundColor: '#131315', borderTopWidth: 1, borderTopColor: BORDER, paddingBottom: 4 },
  navItem:       { flex: 1, alignItems: 'center', paddingVertical: 8 },
  navIcon:       { fontSize: 22, color: MUTED, textAlign: 'center' },
  navIconActive: { color: PURPLE },
  navLabel:      { fontSize: 10, color: MUTED, fontWeight: '500', marginTop: 2 },
  navLabelActive:{ color: PURPLE },
  navBadge:      { position: 'absolute', top: -4, right: -8, backgroundColor: '#ef4444', borderRadius: 8, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  navBadgeText:  { fontSize: 10, fontWeight: '700', color: '#fff' },

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

  proBadge: { backgroundColor: PURPLE + '22', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, borderWidth: 1, borderColor: PURPLE + '55' },
  proBadgeText: { color: '#a78bfa', fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },

  paywallIconRing: { width: 64, height: 64, borderRadius: 32, backgroundColor: PURPLE + '22', borderWidth: 1, borderColor: PURPLE + '55', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  paywallFeatureList: { gap: 10, marginBottom: 4 },
  paywallFeatureRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  paywallFeatureCheck: { color: PURPLE, fontSize: 15, fontWeight: '700', width: 18 },
  paywallFeatureText: { color: TEXT, fontSize: 15, flex: 1, lineHeight: 22 },
  paywallPkgCard: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: BORDER, borderRadius: 12, padding: 14, backgroundColor: SURFACE, gap: 12 },
  paywallPkgCardSelected: { borderColor: PURPLE, backgroundColor: PURPLE + '11' },
  paywallPkgName: { fontSize: 15, fontWeight: '600', color: MUTED },
  paywallBestValue: { backgroundColor: PURPLE + '33', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },
  paywallBestValueText: { color: '#a78bfa', fontSize: 11, fontWeight: '700' },
  paywallRadio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: BORDER, alignItems: 'center', justifyContent: 'center' },
  paywallRadioSelected: { borderColor: PURPLE },
  paywallRadioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: PURPLE },
});
