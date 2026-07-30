import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  NativeModules,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { Contact, Intent, Memory, Platform, PlatformIdentity, Relationship, Tone } from '../types';
import { deletePlatformIdentitiesByContactAndPlatform, getContactById, getPlatformIdentitiesByContact, getSemanticMemoriesByContact, logMerge, updateContactPreferences, upsertPlatformIdentity } from '../services/database';
import { getUnmatchedSenders, linkSenderToContact, unlinkPlatform } from '../services/contactLinking';
import { recomputeClosenessScore } from '../services/contactCloseness';
import { getContactInsights } from '../services/contactInsights';
import type { ContactInsights } from '../services/contactInsights';
import type { UnmatchedSender } from '../services/contactLinking';
import { PLATFORM_ICONS } from '../services/upcomingEvents';
import { PURPLE, SURFACE, SURFACE2, BORDER, TEXT, MUTED, FONTS, CONTEXT } from '../theme';

const { ProTxtSettings } = NativeModules;

const VALID_PLATFORMS: Platform[] = ['whatsapp', 'telegram', 'instagram', 'sms', 'email', 'messenger', 'signal', 'google', 'phone'];

const RELATIONSHIP_EMOJI: Record<Relationship, string> = {
  friend:    '👋',
  colleague: '💼',
  family:    '🏠',
  flatmate:  '🏘️',
  partner:   '❤️',
  other:     '👤',
};

const PLATFORM_LABEL: Record<string, string> = {
  whatsapp:  'WhatsApp',
  telegram:  'Telegram',
  instagram: 'Instagram',
  sms:       'SMS',
  email:     'Email',
  messenger: 'Messenger',
  signal:    'Signal',
  google:    'Google',
  phone:     'Phone',
};

const INTENT_LABEL: Record<Intent, string> = {
  eta: 'ETA', availability: 'Availability', booking: 'Bookings',
  location_share: 'Location', incoming_location: 'Location', task: 'Tasks',
  general: 'General chat', other: 'General chat',
};

function formatReplySpeed(secs: number): string {
  if (secs < 60) return 'within a minute';
  if (secs < 3_600) return `~${Math.round(secs / 60)} min`;
  if (secs < 86_400) return `~${Math.round(secs / 3_600)}h`;
  return 'over a day';
}

// mostActiveHour is already computed in the device's own local time zone
// (ContactSignals.kt's Calendar.getInstance() uses the default zone), so no conversion
// is needed here — it's already the hour the user would recognize as "their" time.
function formatHour(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${hour < 12 ? 'am' : 'pm'}`;
}

function formatVolumeTrend(last7d: number, prior7d: number): string | null {
  if (last7d === 0) return null;
  const msg = `msg${last7d === 1 ? '' : 's'}`;
  if (prior7d === 0) return `${last7d} ${msg} this week`;
  if (last7d >= prior7d * 2) return `${last7d} ${msg} this week (up from ${prior7d})`;
  if (prior7d >= last7d * 2) return `${last7d} ${msg} this week (down from ${prior7d})`;
  return `${last7d} ${msg} this week`;
}

interface Props {
  contactId: string | null;
  onClose: () => void;
  onPreferenceChange?: (id: string, relationship: Contact['relationship'], tone: Contact['preferredTone']) => void;
}

export default function ContactDetailModal({ contactId, onClose, onPreferenceChange }: Props) {
  const [contact, setContact] = useState<Contact | null>(null);
  const [identities, setIdentities] = useState<PlatformIdentity[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [linkPickerVisible, setLinkPickerVisible] = useState(false);
  const [unmatchedSenders, setUnmatchedSenders] = useState<UnmatchedSender[]>([]);
  const [linkSearch, setLinkSearch] = useState('');
  const [linking, setLinking] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<Platform | null>(null);
  const [insights, setInsights] = useState<ContactInsights | null>(null);
  const contactIdRef = useRef<string | null>(null);

  const reloadIdentities = (id: string) => {
    getPlatformIdentitiesByContact(id)
      .then(ids => setIdentities(ids.filter(i => i.identifierType !== 'display_name')))
      .catch(() => {});
  };

  // The much more common automatic "Is this X?" banner path has only ever
  // written to a native confirmed_identities map, never to the platform_identities
  // table the "ON" chips read from — so most real, long-standing links have
  // nothing to show without this. Backfill any native-confirmed link for this
  // contact that isn't already represented (matched by platform, since the
  // native side only knows a display name, not a specific phone/username).
  const backfillConfirmedLinks = async (id: string, currentIdentities: PlatformIdentity[]) => {
    try {
      const json: string = await ProTxtSettings?.getAllConfirmedLinks?.();
      if (!json) return;
      const links = JSON.parse(json) as { convKey: string; contactId: string; displayName: string; platform: string }[];
      const known = new Set(currentIdentities.map(i => i.platform));
      const missing = links.filter(l => l.contactId === id && VALID_PLATFORMS.includes(l.platform as Platform) && !known.has(l.platform as Platform));
      if (missing.length === 0) return;
      const seen = new Set<string>();
      for (const link of missing) {
        if (seen.has(link.platform)) continue;
        seen.add(link.platform);
        await upsertPlatformIdentity({
          contactId: id,
          platform: link.platform as Platform,
          identifier: link.displayName,
          identifierType: 'username',
          confidence: 1,
          userConfirmed: true,
        });
      }
      reloadIdentities(id);
    } catch {
      // Best-effort — the "ON" section just stays as-is if this fails.
    }
  };

  useEffect(() => {
    if (!contactId) { setLoading(false); return; }
    contactIdRef.current = contactId;
    setLoading(true);
    setInsights(null);
    Promise.all([
      getContactById(contactId),
      getPlatformIdentitiesByContact(contactId),
      getSemanticMemoriesByContact(contactId, 15),
    ]).then(([c, ids, mems]) => {
      setContact(c);
      const filtered = ids.filter(i => i.identifierType !== 'display_name');
      setIdentities(filtered);
      setMemories(mems);
      backfillConfirmedLinks(contactId, filtered);
    }).catch(() => {}).finally(() => setLoading(false));

    // Recomputes in the background rather than blocking the modal open — the stored
    // value from getContactById above shows immediately, this just refreshes it.
    // Guarded so a slow response landing after the modal moved to a different contact
    // (or closed) doesn't overwrite what's currently on screen.
    recomputeClosenessScore(contactId).then((score) => {
      if (score == null) return;
      setContact((prev) => (prev && prev.id === contactId ? { ...prev, closenessScore: score } : prev));
    });

    // Same fire-and-forget pattern as closeness above, and the same guard against a
    // stale response landing after the modal moved on.
    getContactInsights(contactId).then((result) => {
      setInsights((prev) => (contactId === contactIdRef.current ? result : prev));
    });
  }, [contactId]);

  const openLinkPicker = () => {
    setLinkSearch('');
    setLinkPickerVisible(true);
    getUnmatchedSenders().then(setUnmatchedSenders);
  };

  const handleLinkSender = async (sender: UnmatchedSender) => {
    if (!contact) return;
    setLinking(sender.convKey);
    try {
      await linkSenderToContact(sender.convKey, contact.id);
      if (VALID_PLATFORMS.includes(sender.platform as Platform)) {
        await upsertPlatformIdentity({
          contactId: contact.id,
          platform: sender.platform as Platform,
          identifier: sender.displayName,
          identifierType: 'username',
          confidence: 1,
          userConfirmed: true,
        });
        reloadIdentities(contact.id);
      }
      setUnmatchedSenders(prev => prev.filter(s => s.convKey !== sender.convKey));
      setLinkPickerVisible(false);
    } catch {
      // Best-effort — leave the picker open so the user can retry.
    } finally {
      setLinking(null);
    }
  };

  // Excludes any unmatched sender whose name is this same contact — getUnmatchedSenders()
  // has no concept of "already the contact you're viewing" (it only knows a sender is
  // unmatched, not who it might actually be), so without this a contact who has two
  // technically-distinct identities under the same display name (e.g. a convKey
  // collision — see IDEAS.md's "Same-name contact collision" notes) gets offered as a
  // link target for itself.
  const ownName = contact?.displayName.trim().toLowerCase();
  const filteredUnmatched = unmatchedSenders.filter(s =>
    s.displayName.trim().toLowerCase() !== ownName &&
    (!linkSearch.trim() || s.displayName.toLowerCase().includes(linkSearch.trim().toLowerCase()))
  );

  // Removes both halves of a link: the native confirmed_identities entries that
  // actually drive matching (unlinkPlatform), and the platform_identities rows the
  // "ON" chip reads from (deletePlatformIdentitiesByContactAndPlatform). Doing only
  // the second would be cosmetic — backfillConfirmedLinks would silently re-add the
  // chip next time this modal opens, since the native side would still consider the
  // sender linked.
  const confirmUnlink = (platform: Platform, label: string) => {
    if (!contact) return;
    Alert.alert(
      `Unlink ${label}?`,
      'ConTxt will treat future messages from this sender as unrecognised again, until you link them a second time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unlink', style: 'destructive', onPress: async () => {
            setUnlinking(platform);
            try {
              await unlinkPlatform(contact.id, platform);
              await deletePlatformIdentitiesByContactAndPlatform(contact.id, platform);
              await logMerge(contact.id, 'unlinked', platform);
              reloadIdentities(contact.id);
            } finally {
              setUnlinking(null);
            }
          },
        },
      ],
    );
  };

  const handleRelationship = async (r: Relationship) => {
    if (!contact) return;
    const next = contact.relationship === r ? undefined : r;
    await updateContactPreferences(contact.id, next, contact.preferredTone);
    setContact(c => c ? { ...c, relationship: next } : c);
    onPreferenceChange?.(contact.id, next, contact.preferredTone);
  };

  const handleTone = async (t: Tone) => {
    if (!contact) return;
    const next = contact.preferredTone === t ? undefined : t;
    await updateContactPreferences(contact.id, contact.relationship, next);
    setContact(c => c ? { ...c, preferredTone: next } : c);
    onPreferenceChange?.(contact.id, contact.relationship, next);
  };

  const sinceLabel = contact
    ? new Date(contact.createdAt).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
    : '';

  return (
    <Modal visible={!!contactId} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />

          {loading || !contact ? (
            <View style={styles.loadingState}>
              <Text style={styles.loadingText}>{loading ? 'Loading…' : 'Contact not found'}</Text>
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
              {/* Header */}
              <View style={styles.header}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {contact.relationship ? RELATIONSHIP_EMOJI[contact.relationship] : contact.displayName.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.headerInfo}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={styles.name}>{contact.displayName}</Text>
                    {Array.from(new Set(identities.map(i => i.platform))).length > 0 && (
                      <View style={{ flexDirection: 'row', marginLeft: 8, gap: 3 }}>
                        {Array.from(new Set(identities.map(i => i.platform))).map(p => (
                          <Text key={p} style={{ fontSize: 15 }}>{PLATFORM_ICONS[p] ?? '📱'}</Text>
                        ))}
                      </View>
                    )}
                  </View>
                  <Text style={styles.meta}>
                    {[
                      contact.interactionCount ? `${contact.interactionCount} interactions` : null,
                      sinceLabel ? `since ${sinceLabel}` : null,
                      contact.closenessScore != null ? `${Math.round(contact.closenessScore * 100)}% close` : null,
                    ].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              </View>

              {/* Platform identities */}
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>ON</Text>
                <View style={styles.chipRow}>
                  {identities.map(id => (
                    <View key={id.id} style={styles.platformChip}>
                      <Text style={styles.platformIcon}>{PLATFORM_ICONS[id.platform] ?? '📱'}</Text>
                      <Text style={styles.platformLabel}>{PLATFORM_LABEL[id.platform] ?? id.platform}</Text>
                      {id.identifierType !== 'display_name' && (
                        <Text style={styles.platformIdentifier} numberOfLines={1}>
                          {id.identifierType === 'phone'
                            ? id.identifier
                            : id.identifierType === 'username'
                              ? `@${id.identifier.replace(/^@/, '')}`
                              : id.identifier}
                        </Text>
                      )}
                      <Pressable
                        hitSlop={8}
                        disabled={unlinking === id.platform}
                        onPress={() => confirmUnlink(id.platform, PLATFORM_LABEL[id.platform] ?? id.platform)}
                      >
                        <Text style={styles.platformUnlink}>{unlinking === id.platform ? '…' : '✕'}</Text>
                      </Pressable>
                    </View>
                  ))}
                  <Pressable style={styles.addPlatformChip} onPress={openLinkPicker}>
                    <Text style={styles.addPlatformChipText}>+ Link another app</Text>
                  </Pressable>
                </View>
              </View>

              {/* Memories */}
              {memories.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>KNOWS ABOUT THEM</Text>
                  <View style={styles.memoriesBox}>
                    {memories.map(m => (
                      <View key={m.id} style={styles.memoryRow}>
                        <Text style={styles.memoryDot}>·</Text>
                        <Text style={styles.memoryText}>{m.content}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}

              {memories.length === 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>KNOWS ABOUT THEM</Text>
                  <Text style={styles.emptyHint}>Facts will appear here as you have more conversations.</Text>
                </View>
              )}

              {/* Insights — reply cadence, activity pattern, most common intent */}
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>INSIGHTS</Text>
                {(() => {
                  const rows: string[] = [];
                  if (insights) {
                    const trend = formatVolumeTrend(insights.msgsLast7d, insights.msgsPrior7d);
                    if (trend) rows.push(trend);
                    if (insights.avgReplySecs != null) rows.push(`Typically replies ${formatReplySpeed(insights.avgReplySecs)}`);
                    if (insights.mostActiveHour != null) rows.push(`Most active around ${formatHour(insights.mostActiveHour)}`);
                    if (insights.topIntent) rows.push(`Usually messages about: ${INTENT_LABEL[insights.topIntent]}`);
                  }
                  return rows.length > 0 ? (
                    <View style={styles.memoriesBox}>
                      {rows.map((row) => (
                        <View key={row} style={styles.memoryRow}>
                          <Text style={styles.memoryDot}>·</Text>
                          <Text style={styles.memoryText}>{row}</Text>
                        </View>
                      ))}
                    </View>
                  ) : (
                    <Text style={styles.emptyHint}>Patterns will appear here as you exchange more messages.</Text>
                  );
                })()}
              </View>

              {/* Relationship */}
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>RELATIONSHIP</Text>
                <View style={styles.chipRow}>
                  {(['friend', 'colleague', 'family', 'flatmate', 'partner', 'other'] as Relationship[]).map(r => (
                    <Pressable
                      key={r}
                      style={[styles.chip, contact.relationship === r && styles.chipActive]}
                      onPress={() => handleRelationship(r)}
                    >
                      <Text style={[styles.chipText, contact.relationship === r && styles.chipTextActive]}>
                        {r.charAt(0).toUpperCase() + r.slice(1)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Preferred tone */}
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>PREFERRED TONE FOR SUGGESTIONS</Text>
                <View style={styles.chipRow}>
                  {([['casual', 'Casual 😊'], ['formal', 'Formal 🎩'], ['brief', 'Brief ⚡']] as [Tone, string][]).map(([t, label]) => (
                    <Pressable
                      key={t}
                      style={[styles.chip, contact.preferredTone === t && styles.chipActive]}
                      onPress={() => handleTone(t)}
                    >
                      <Text style={[styles.chipText, contact.preferredTone === t && styles.chipTextActive]}>{label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </ScrollView>
          )}

          <Pressable style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeBtnText}>Done</Text>
          </Pressable>
        </Pressable>
      </Pressable>

      <Modal visible={linkPickerVisible} transparent animationType="slide" onRequestClose={() => setLinkPickerVisible(false)}>
        <Pressable style={styles.overlay} onPress={() => setLinkPickerVisible(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.handle} />
            <Text style={styles.pickerTitle}>Link another app</Text>
            <Text style={styles.pickerHint}>
              Pick a sender ConTxt has seen but hasn't matched to a contact — this links them to {contact?.displayName ?? 'this contact'}.
            </Text>
            <TextInput
              style={styles.pickerSearch}
              placeholder="Search…"
              placeholderTextColor={MUTED}
              value={linkSearch}
              onChangeText={setLinkSearch}
            />
            <ScrollView style={styles.pickerList} contentContainerStyle={{ paddingBottom: 8 }}>
              {filteredUnmatched.length === 0 && (
                <Text style={styles.emptyHint}>
                  {unmatchedSenders.length === 0 ? 'No unmatched senders found.' : 'No matches.'}
                </Text>
              )}
              {filteredUnmatched.map(sender => (
                <Pressable
                  key={sender.convKey}
                  style={styles.pickerRow}
                  disabled={linking === sender.convKey}
                  onPress={() => handleLinkSender(sender)}
                >
                  <Text style={styles.platformIcon}>{PLATFORM_ICONS[sender.platform] ?? '📱'}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickerRowName}>{sender.displayName}</Text>
                    <Text style={styles.pickerRowPlatform}>{sender.platformLabel}</Text>
                  </View>
                  <Text style={styles.pickerRowAction}>{linking === sender.convKey ? '…' : 'Link'}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable style={styles.closeBtn} onPress={() => setLinkPickerVisible(false)}>
              <Text style={styles.closeBtnText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: '#000000bb', justifyContent: 'flex-end' },
  sheet:   { backgroundColor: SURFACE, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: BORDER, borderBottomWidth: 0, maxHeight: '90%', paddingBottom: 8 },
  handle:  { width: 36, height: 4, backgroundColor: BORDER, borderRadius: 2, alignSelf: 'center', marginTop: 12, marginBottom: 4 },
  content: { padding: 20, paddingTop: 8, paddingBottom: 16 },

  loadingState: { padding: 40, alignItems: 'center' },
  loadingText:  { color: MUTED, fontSize: 15 },

  header:     { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 24 },
  avatar:     { width: 52, height: 52, borderRadius: 26, backgroundColor: PURPLE + '25', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: PURPLE + '40' },
  avatarText: { fontSize: 24 },
  headerInfo: { flex: 1 },
  name:       { fontSize: 20, fontFamily: FONTS.bold, fontWeight: '700', color: TEXT, letterSpacing: -0.3 },
  meta:       { fontSize: 12, color: MUTED, fontFamily: FONTS.mono, marginTop: 3 },

  section:      { marginBottom: 22 },
  sectionLabel: { fontSize: 10, fontFamily: FONTS.semibold, fontWeight: '600', color: MUTED, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip:         { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: BORDER, backgroundColor: SURFACE2 },
  chipActive:   { borderColor: PURPLE, backgroundColor: PURPLE + '20' },
  chipText:     { fontSize: 13, color: MUTED, fontFamily: FONTS.medium, fontWeight: '500' },
  chipTextActive: { color: PURPLE, fontFamily: FONTS.semibold, fontWeight: '600' },

  // Platform identities use the CONTEXT (teal) accent rather than SIGNAL —
  // these are passive "where we've seen this person" signals, not an
  // actionable/urgent state, so they get the secondary accent per the
  // SIGNAL-for-action / CONTEXT-for-context-signal split used elsewhere.
  platformChip:       { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: CONTEXT + '15', borderWidth: 1, borderColor: CONTEXT + '40', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 },
  platformIcon:       { fontSize: 13 },
  platformLabel:      { fontSize: 12, color: TEXT, fontFamily: FONTS.medium, fontWeight: '500' },
  platformIdentifier: { fontSize: 11, color: CONTEXT, fontFamily: FONTS.mono, maxWidth: 120 },
  platformUnlink:     { fontSize: 12, color: MUTED, marginLeft: 2, paddingHorizontal: 2 },

  addPlatformChip:     { borderWidth: 1, borderColor: BORDER, borderStyle: 'dashed', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 },
  addPlatformChipText: { fontSize: 12, color: MUTED, fontFamily: FONTS.medium, fontWeight: '500' },

  memoriesBox: { backgroundColor: SURFACE2, borderRadius: 14, borderWidth: 1, borderColor: BORDER, padding: 12, gap: 8 },
  memoryRow:   { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  memoryDot:   { color: PURPLE, fontSize: 16, lineHeight: 20, marginTop: 1 },
  memoryText:  { flex: 1, fontSize: 13, color: TEXT, lineHeight: 20 },

  emptyHint: { fontSize: 13, color: MUTED, fontStyle: 'italic' },

  closeBtn:     { margin: 16, marginTop: 8, backgroundColor: PURPLE, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  closeBtnText: { fontSize: 15, fontFamily: FONTS.semibold, fontWeight: '600', color: '#fff' },

  pickerTitle: { fontSize: 17, fontFamily: FONTS.bold, fontWeight: '700', color: TEXT, paddingHorizontal: 20, marginTop: 8 },
  pickerHint:  { fontSize: 12, color: MUTED, paddingHorizontal: 20, marginTop: 6, marginBottom: 14, lineHeight: 17 },
  pickerSearch: { marginHorizontal: 20, backgroundColor: SURFACE2, borderWidth: 1, borderColor: BORDER, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: TEXT, fontFamily: FONTS.regular, fontSize: 14, marginBottom: 10 },
  pickerList:  { maxHeight: 320, paddingHorizontal: 20 },
  pickerRow:   { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: BORDER },
  pickerRowName:     { fontSize: 14, color: TEXT, fontFamily: FONTS.medium, fontWeight: '500' },
  pickerRowPlatform: { fontSize: 12, color: MUTED, marginTop: 1 },
  pickerRowAction:   { fontSize: 13, color: PURPLE, fontFamily: FONTS.semibold, fontWeight: '600' },
});
