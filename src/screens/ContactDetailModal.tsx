import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { Contact, Memory, PlatformIdentity, Relationship, Tone } from '../types';
import { getContactById, getPlatformIdentitiesByContact, getSemanticMemoriesByContact, updateContactPreferences } from '../services/database';
import { PLATFORM_ICONS } from '../services/upcomingEvents';

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
                  <Text style={styles.name}>{contact.displayName}</Text>
                  <Text style={styles.meta}>
                    {[
                      contact.interactionCount ? `${contact.interactionCount} interactions` : null,
                      sinceLabel ? `since ${sinceLabel}` : null,
                    ].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              </View>

              {/* Platform identities */}
              {identities.length > 0 && (
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
                  </View>
                </View>
              )}

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

  memoriesBox: { backgroundColor: SURFACE, borderRadius: 14, borderWidth: 1, borderColor: BORDER, padding: 12, gap: 6 },
  memoryRow:   { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  memoryDot:   { color: PURPLE, fontSize: 16, lineHeight: 20, marginTop: 1 },
  memoryText:  { flex: 1, fontSize: 13, color: TEXT, lineHeight: 20 },

  emptyHint: { fontSize: 13, color: MUTED, fontStyle: 'italic' },

  closeBtn:     { margin: 16, marginTop: 8, backgroundColor: PURPLE, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  closeBtnText: { fontSize: 15, fontWeight: '600', color: '#fff' },
});
