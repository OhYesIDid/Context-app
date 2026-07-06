import React, { useEffect, useState } from 'react';
import {
  Modal,
  NativeModules,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { Contact, Memory, Platform, PlatformIdentity, Relationship, Tone } from '../types';
import { getContactById, getPlatformIdentitiesByContact, getSemanticMemoriesByContact, updateContactPreferences, upsertPlatformIdentity } from '../services/database';
import { PLATFORM_ICONS } from '../services/upcomingEvents';

const { ProTxtSettings } = NativeModules;

const VALID_PLATFORMS: Platform[] = ['whatsapp', 'telegram', 'instagram', 'sms', 'email', 'messenger', 'signal', 'google', 'phone'];

interface UnmatchedSender {
  convKey: string;
  displayName: string;
  platformLabel: string;
  platform: string;
}

const PURPLE  = '#6366f1';
const SURFACE = '#18181b';
const BORDER  = '#27272a';
const TEXT    = '#f4f4f5';
const MUTED   = '#71717a';

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

  const reloadIdentities = (id: string) => {
    getPlatformIdentitiesByContact(id)
      .then(ids => setIdentities(ids.filter(i => i.identifierType !== 'display_name')))
      .catch(() => {});
  };

  useEffect(() => {
    if (!contactId) { setLoading(false); return; }
    setLoading(true);
    Promise.all([
      getContactById(contactId),
      getPlatformIdentitiesByContact(contactId),
      getSemanticMemoriesByContact(contactId, 15),
    ]).then(([c, ids, mems]) => {
      setContact(c);
      setIdentities(ids.filter(i => i.identifierType !== 'display_name'));
      setMemories(mems);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [contactId]);

  const openLinkPicker = () => {
    setLinkSearch('');
    setLinkPickerVisible(true);
    ProTxtSettings?.getUnmatchedSenders?.()
      .then((json: string) => setUnmatchedSenders(JSON.parse(json)))
      .catch(() => setUnmatchedSenders([]));
  };

  const handleLinkSender = async (sender: UnmatchedSender) => {
    if (!contact) return;
    setLinking(sender.convKey);
    try {
      await ProTxtSettings?.linkSenderToContact?.(sender.convKey, contact.id);
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

  const filteredUnmatched = unmatchedSenders.filter(s =>
    !linkSearch.trim() || s.displayName.toLowerCase().includes(linkSearch.trim().toLowerCase())
  );

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
  sheet:   { backgroundColor: '#1c1c1e', borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '90%', paddingBottom: 8 },
  handle:  { width: 36, height: 4, backgroundColor: BORDER, borderRadius: 2, alignSelf: 'center', marginTop: 12, marginBottom: 4 },
  content: { padding: 20, paddingTop: 8, paddingBottom: 16 },

  loadingState: { padding: 40, alignItems: 'center' },
  loadingText:  { color: MUTED, fontSize: 15 },

  header:     { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 20 },
  avatar:     { width: 52, height: 52, borderRadius: 26, backgroundColor: '#6366f130', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#6366f140' },
  avatarText: { fontSize: 24 },
  headerInfo: { flex: 1 },
  name:       { fontSize: 20, fontWeight: '700', color: TEXT, letterSpacing: -0.3 },
  meta:       { fontSize: 12, color: MUTED, marginTop: 2 },

  section:      { marginBottom: 20 },
  sectionLabel: { fontSize: 10, fontWeight: '700', color: MUTED, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip:         { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: BORDER, backgroundColor: SURFACE },
  chipActive:   { borderColor: PURPLE, backgroundColor: '#6366f120' },
  chipText:     { fontSize: 13, color: MUTED },
  chipTextActive: { color: PURPLE, fontWeight: '600' },

  platformChip:       { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 },
  platformIcon:       { fontSize: 13 },
  platformLabel:      { fontSize: 12, color: TEXT, fontWeight: '500' },
  platformIdentifier: { fontSize: 11, color: MUTED, maxWidth: 120 },

  addPlatformChip:     { borderWidth: 1, borderColor: BORDER, borderStyle: 'dashed', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 },
  addPlatformChipText: { fontSize: 12, color: MUTED, fontWeight: '500' },

  memoriesBox: { backgroundColor: SURFACE, borderRadius: 14, borderWidth: 1, borderColor: BORDER, padding: 12, gap: 6 },
  memoryRow:   { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  memoryDot:   { color: PURPLE, fontSize: 16, lineHeight: 20, marginTop: 1 },
  memoryText:  { flex: 1, fontSize: 13, color: TEXT, lineHeight: 20 },

  emptyHint: { fontSize: 13, color: MUTED, fontStyle: 'italic' },

  closeBtn:     { margin: 16, marginTop: 8, backgroundColor: PURPLE, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  closeBtnText: { fontSize: 15, fontWeight: '600', color: '#fff' },

  pickerTitle: { fontSize: 17, fontWeight: '700', color: TEXT, paddingHorizontal: 20, marginTop: 8 },
  pickerHint:  { fontSize: 12, color: MUTED, paddingHorizontal: 20, marginTop: 6, marginBottom: 14, lineHeight: 17 },
  pickerSearch: { marginHorizontal: 20, backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: TEXT, fontSize: 14, marginBottom: 10 },
  pickerList:  { maxHeight: 320, paddingHorizontal: 20 },
  pickerRow:   { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: BORDER },
  pickerRowName:     { fontSize: 14, color: TEXT, fontWeight: '500' },
  pickerRowPlatform: { fontSize: 12, color: MUTED, marginTop: 1 },
  pickerRowAction:   { fontSize: 13, color: PURPLE, fontWeight: '600' },
});
