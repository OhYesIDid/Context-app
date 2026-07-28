import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Contact, Relationship, Tone } from '../types';
import type { PendingContactLink, UnmatchedSender } from '../services/contactLinking';
import { PLATFORM_ICONS } from '../services/upcomingEvents';
import { PURPLE, BG, SURFACE, SURFACE2, BORDER, TEXT, MUTED, CONTEXT, AMBER, FONTS } from '../theme';

const TONE_LABEL: Record<Tone, string> = { casual: 'Casual', formal: 'Formal', brief: 'Brief' };

function SetupRow({ label, status, done, loading, onPress }: { label: string; status: string; done: boolean; loading: boolean; onPress: () => void }) {
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

// Mirrors BubbleSuggestionActivity's own bannerText logic exactly, so the same
// suggestion reads identically whether it's answered in the bubble or here later.
function bannerText(link: PendingContactLink): string {
  if (link.crossApp) return `Same person as ${link.displayName}?`;
  if (link.confidence >= 0.88) return `Is this ${link.displayName}?`;
  return `Possibly ${link.displayName}?`;
}

// The link picker serves two related-but-distinct flows off one contact list + search
// + "create new" UI: linking a sender that matched NOBODY (no guess to confirm/decline,
// just "pick who this is"), and answering "not them" on a suggestion that already had a
// guess (adds a "None of these" decline option the unmatched-sender flow doesn't need,
// since there's nothing to decline there).
type LinkPickerTarget =
  | { kind: 'unmatched'; sender: UnmatchedSender }
  | { kind: 'suggestion'; link: PendingContactLink };

function targetConvKey(t: LinkPickerTarget): string {
  return t.kind === 'unmatched' ? t.sender.convKey : t.link.convKey;
}
function targetDisplayName(t: LinkPickerTarget): string {
  return t.kind === 'unmatched' ? t.sender.displayName : t.link.senderName;
}
function targetPlatformLabel(t: LinkPickerTarget): string {
  return t.kind === 'unmatched' ? t.sender.platformLabel : (t.link.platform ?? 'another app');
}
// Both onLinkSenderToContact/onCreateContactFromSender take an UnmatchedSender shape —
// a PendingContactLink carries the same senderName/convKey/platform, so it converts
// directly rather than needing its own pair of App.tsx handlers.
function targetAsSender(t: LinkPickerTarget): UnmatchedSender {
  if (t.kind === 'unmatched') return t.sender;
  return { convKey: t.link.convKey, displayName: t.link.senderName, platform: t.link.platform ?? 'other', platformLabel: t.link.platform ?? 'another app' };
}

interface Props {
  contacts: Contact[];
  contactPlatforms: Record<string, string[]>;
  contactSearch: string;
  onSearchChange: (s: string) => void;
  unmatchedSenders: UnmatchedSender[];
  pendingContactLinks: PendingContactLink[];
  linkingSenderKey: string | null;
  googleContactsCount: number | null;
  deviceContactsCount: number | null;
  whatsappMessages: number | null;
  setupLoading: string | null;
  onImportGoogle: () => void;
  onImportDevice: () => void;
  onImportWhatsApp: () => void;
  onNewContact: () => void;
  onSelectContact: (id: string) => void;
  onUpdatePref: (id: string, field: 'relationship' | 'preferredTone', value: string | undefined) => void;
  onLinkSenderToContact: (sender: UnmatchedSender, contactId: string) => void;
  onCreateContactFromSender: (sender: UnmatchedSender) => void;
  onResolvePendingLink: (link: PendingContactLink, contactId: string) => void;
  onDeclinePendingLink: (link: PendingContactLink) => void;
  onGoToSettings: () => void;
}

export default function ContactsScreen({
  contacts, contactPlatforms, contactSearch, onSearchChange, unmatchedSenders, pendingContactLinks, linkingSenderKey,
  googleContactsCount, deviceContactsCount, whatsappMessages, setupLoading,
  onImportGoogle, onImportDevice, onImportWhatsApp, onNewContact, onSelectContact, onUpdatePref,
  onLinkSenderToContact, onCreateContactFromSender, onResolvePendingLink, onDeclinePendingLink, onGoToSettings,
}: Props) {
  const [linkPickerTarget, setLinkPickerTarget] = useState<LinkPickerTarget | null>(null);
  const [pickerSearch, setPickerSearch] = useState('');

  const shown = contactSearch
    ? contacts.filter((c) => c.displayName.toLowerCase().includes(contactSearch.toLowerCase()))
    : contacts.slice(0, 10);

  // A "suggestion" target already has a declined/primary guess (link.contactId) — leaving
  // it in the list would let "Not them" loop right back to the same contact it was just
  // declined for, so it's excluded here rather than only from the search-filtered view.
  const pickerBase = linkPickerTarget?.kind === 'suggestion'
    ? contacts.filter((c) => c.id !== linkPickerTarget.link.contactId)
    : contacts;
  const pickerContacts = pickerSearch
    ? pickerBase.filter((c) => c.displayName.toLowerCase().includes(pickerSearch.trim().toLowerCase()))
    : pickerBase;

  const openPicker = (t: LinkPickerTarget) => { setPickerSearch(''); setLinkPickerTarget(t); };

  const handlePickerSelect = (contactId: string) => {
    if (!linkPickerTarget) return;
    if (linkPickerTarget.kind === 'unmatched') onLinkSenderToContact(linkPickerTarget.sender, contactId);
    else onResolvePendingLink(linkPickerTarget.link, contactId);
    setLinkPickerTarget(null);
  };

  const handlePickerCreate = () => {
    if (!linkPickerTarget) return;
    onCreateContactFromSender(targetAsSender(linkPickerTarget));
    setLinkPickerTarget(null);
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Contacts</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable style={styles.smallButton} onPress={onNewContact}>
            <Text style={styles.smallButtonText}>+ New</Text>
          </Pressable>
          <Pressable onPress={onGoToSettings} style={styles.settingsBtn}>
            <Text style={styles.settingsIcon}>⚙</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search contacts…"
          placeholderTextColor={MUTED}
          value={contactSearch}
          onChangeText={onSearchChange}
          autoCorrect={false}
        />

        {/* Suggested links — a fuzzy-match banner the bubble posed but the user never
            answered. Previously these evaporated the moment the bubble was dismissed;
            now they're queued (ContactLinkStore.kt) until answered here or the next
            message resolves them another way. */}
        {pendingContactLinks.length > 0 && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={styles.cardTitleRow}>
                <View style={[styles.cardIcon, { backgroundColor: AMBER + '20' }]}>
                  <Text style={styles.cardIconText}>💡</Text>
                </View>
                <Text style={styles.cardTitle}>Suggested links</Text>
                <View style={styles.countBadge}>
                  <Text style={styles.countBadgeText}>{pendingContactLinks.length}</Text>
                </View>
              </View>
            </View>
            <Text style={styles.cardHint}>ConTxt noticed a possible match — confirm or decline.</Text>
            <View style={styles.divider} />
            {pendingContactLinks.map((link) => (
              <View key={link.convKey} style={styles.suggestionRow}>
                <Text style={styles.platformIcon}>{PLATFORM_ICONS[link.platform ?? ''] ?? '📱'}</Text>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.suggestionTitle} numberOfLines={1}>{bannerText(link)}</Text>
                  <Text style={styles.senderMeta} numberOfLines={1}>
                    {link.senderName}{link.platform ? ` · ${link.platform}` : ''}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 14 }}>
                  <Pressable onPress={() => onResolvePendingLink(link, link.contactId)}>
                    <Text style={styles.suggestionYes}>Yes</Text>
                  </Pressable>
                  <Pressable onPress={() => openPicker({ kind: 'suggestion', link })}>
                    <Text style={styles.suggestionNo}>Not them</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Unlinked senders — every sender ConTxt has seen across every app that's
            never been matched to a contact (native getUnmatchedSenders(), the same
            list ContactDetailModal's "+ Link another app" picker already reads —
            surfaced here proactively instead of only when you happen to open the
            right contact and go looking for it). */}
        {unmatchedSenders.length > 0 && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={styles.cardTitleRow}>
                <View style={[styles.cardIcon, { backgroundColor: CONTEXT + '20' }]}>
                  <Text style={styles.cardIconText}>🔗</Text>
                </View>
                <Text style={styles.cardTitle}>Unlinked senders</Text>
                <View style={styles.countBadge}>
                  <Text style={styles.countBadgeText}>{unmatchedSenders.length}</Text>
                </View>
              </View>
            </View>
            <Text style={styles.cardHint}>Seen messaging you, but not linked to a contact yet.</Text>
            <View style={styles.divider} />
            {unmatchedSenders.slice(0, 8).map((sender) => (
              <Pressable
                key={sender.convKey}
                style={styles.senderRow}
                disabled={linkingSenderKey === sender.convKey}
                onPress={() => openPicker({ kind: 'unmatched', sender })}
              >
                <Text style={styles.platformIcon}>{PLATFORM_ICONS[sender.platform] ?? '📱'}</Text>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.senderName} numberOfLines={1}>{sender.displayName}</Text>
                  <Text style={styles.senderMeta}>{sender.platformLabel}</Text>
                </View>
                <Text style={styles.senderAction}>{linkingSenderKey === sender.convKey ? '…' : 'Link'}</Text>
              </Pressable>
            ))}
          </View>
        )}

        <Text style={styles.modalSection}>IMPORT</Text>
        <View style={styles.card}>
          <SetupRow
            label="Google Contacts"
            status={googleContactsCount !== null ? `${googleContactsCount} imported` : 'Not imported'}
            done={googleContactsCount !== null}
            loading={setupLoading === 'google'}
            onPress={onImportGoogle}
          />
          <SetupRow
            label="Device Contacts"
            status={deviceContactsCount !== null ? `${deviceContactsCount} imported` : 'Not imported'}
            done={deviceContactsCount !== null}
            loading={setupLoading === 'device'}
            onPress={onImportDevice}
          />
          <SetupRow
            label="WhatsApp History"
            status={whatsappMessages !== null ? `${whatsappMessages} messages` : 'Not imported'}
            done={whatsappMessages !== null}
            loading={setupLoading === 'whatsapp'}
            onPress={onImportWhatsApp}
          />
        </View>

        {contacts.length > 0 && <Text style={[styles.modalSection, { marginTop: 4 }]}>PREFERENCES</Text>}
        {contacts.length === 0 ? (
          <Text style={styles.emptyHint}>Import contacts above to configure preferences.</Text>
        ) : (
          <>
            {!contactSearch && <Text style={styles.emptyHint}>Top 10 by interactions — search for others</Text>}
            {shown.map((c) => (
              <View key={c.id} style={styles.contactCard}>
                <Pressable onPress={() => onSelectContact(c.id)} style={styles.contactCardHeader}>
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
                  <Text style={styles.viewProfile}>View profile</Text>
                </Pressable>
                <Text style={styles.chipLabel}>Relationship</Text>
                <View style={styles.chipRow}>
                  {(['friend', 'colleague', 'family', 'partner', 'flatmate', 'other'] as Relationship[]).map((r) => (
                    <Pressable
                      key={r}
                      style={[styles.chip, c.relationship === r && styles.chipActive]}
                      onPress={() => onUpdatePref(c.id, 'relationship', c.relationship === r ? undefined : r)}
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
                      onPress={() => onUpdatePref(c.id, 'preferredTone', c.preferredTone === t ? undefined : t)}
                    >
                      <Text style={[styles.chipText, c.preferredTone === t && styles.chipTextActive]}>
                        {TONE_LABEL[t]}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ))}
            {shown.length === 0 && <Text style={styles.emptyHint}>No contacts match "{contactSearch}"</Text>}
          </>
        )}
      </ScrollView>

      {/* Link picker — pick an existing contact for this sender, decline (suggestions
          only), or create a new one. Inverse of ContactDetailModal's own picker (that
          one picks a sender for a known contact; this picks a contact for a known
          sender). */}
      <Modal visible={!!linkPickerTarget} transparent animationType="slide" onRequestClose={() => setLinkPickerTarget(null)}>
        <Pressable style={styles.overlay} onPress={() => setLinkPickerTarget(null)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.handle} />
            {linkPickerTarget && (
              <>
                <Text style={styles.pickerTitle}>Link {targetDisplayName(linkPickerTarget)}</Text>
                <Text style={styles.pickerHint}>
                  Seen on {targetPlatformLabel(linkPickerTarget)}. Pick who this is, or create a new contact.
                </Text>
                {linkPickerTarget.kind === 'suggestion' && (
                  <Pressable
                    style={styles.declineRow}
                    onPress={() => { onDeclinePendingLink(linkPickerTarget.link); setLinkPickerTarget(null); }}
                  >
                    <Text style={styles.declineRowText}>None of these — don't suggest again</Text>
                  </Pressable>
                )}
                <Pressable style={styles.createRow} onPress={handlePickerCreate}>
                  <Text style={styles.createRowText}>+ Create "{targetDisplayName(linkPickerTarget)}" as a new contact</Text>
                </Pressable>
              </>
            )}
            <TextInput
              style={styles.pickerSearch}
              placeholder="Search your contacts…"
              placeholderTextColor={MUTED}
              value={pickerSearch}
              onChangeText={setPickerSearch}
            />
            <ScrollView style={styles.pickerList} contentContainerStyle={{ paddingBottom: 8 }}>
              {pickerContacts.length === 0 && <Text style={styles.emptyHint}>No matches.</Text>}
              {pickerContacts.map((c) => (
                <Pressable key={c.id} style={styles.pickerRow} onPress={() => handlePickerSelect(c.id)}>
                  <Text style={styles.pickerRowName} numberOfLines={1}>{c.displayName}</Text>
                  {(contactPlatforms[c.id]?.length ?? 0) > 0 && (
                    <View style={{ flexDirection: 'row', gap: 3 }}>
                      {contactPlatforms[c.id].map((p) => (
                        <Text key={p} style={{ fontSize: 13 }}>{PLATFORM_ICONS[p] ?? '📱'}</Text>
                      ))}
                    </View>
                  )}
                  <Text style={styles.pickerRowAction}>Link</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable style={styles.closeBtn} onPress={() => setLinkPickerTarget(null)}>
              <Text style={styles.closeBtnText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  title:  { fontSize: 24, fontFamily: FONTS.bold, fontWeight: '700', color: TEXT, letterSpacing: -0.5 },
  settingsBtn:  { width: 36, height: 36, borderRadius: 12, backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, alignItems: 'center', justifyContent: 'center' },
  settingsIcon: { fontSize: 17, color: MUTED },
  smallButton: { backgroundColor: PURPLE, borderRadius: 12, paddingHorizontal: 14, justifyContent: 'center' },
  smallButtonText: { color: '#fff', fontFamily: FONTS.semibold, fontWeight: '600', fontSize: 13 },

  list: { flex: 1 },
  listContent: { padding: 16, paddingTop: 4, paddingBottom: 40 },

  searchInput: { backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, color: TEXT, fontFamily: FONTS.regular, fontSize: 14, marginBottom: 16 },

  card: { backgroundColor: SURFACE, borderRadius: 18, borderWidth: 1, borderColor: BORDER, marginBottom: 16, overflow: 'hidden' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, paddingBottom: 4 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardIcon:    { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  cardIconText: { fontSize: 16 },
  cardTitle:   { fontSize: 15, fontFamily: FONTS.semibold, fontWeight: '600', color: TEXT },
  cardHint:    { fontSize: 12, color: MUTED, paddingHorizontal: 14, paddingBottom: 10 },
  countBadge:     { marginLeft: 'auto', backgroundColor: SURFACE2, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 2 },
  countBadgeText: { fontSize: 11, fontFamily: FONTS.monoSemibold, fontWeight: '600', color: MUTED },
  divider:     { height: 1, backgroundColor: BORDER, marginHorizontal: 14 },

  suggestionRow:   { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: BORDER },
  suggestionTitle: { fontSize: 14, color: TEXT, fontFamily: FONTS.medium, fontWeight: '500' },
  suggestionYes:   { fontSize: 13, color: AMBER, fontFamily: FONTS.semibold, fontWeight: '600' },
  suggestionNo:    { fontSize: 13, color: MUTED, fontFamily: FONTS.medium, fontWeight: '500' },

  senderRow:    { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: BORDER },
  platformIcon: { fontSize: 16 },
  senderName:   { fontSize: 14, color: TEXT, fontFamily: FONTS.medium, fontWeight: '500' },
  senderMeta:   { fontSize: 12, color: MUTED, marginTop: 1 },
  senderAction: { fontSize: 13, color: PURPLE, fontFamily: FONTS.semibold, fontWeight: '600' },

  settingRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: BORDER },
  settingLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  settingText: { fontSize: 14, color: TEXT, fontFamily: FONTS.medium, fontWeight: '500' },
  setupDot:      { fontSize: 16, color: MUTED, width: 16, textAlign: 'center' },
  setupDotDone:  { color: '#22c55e' },
  setupStatus: { fontSize: 12, color: MUTED, marginTop: 1 },
  setupAction: { fontSize: 13, color: PURPLE, fontFamily: FONTS.semibold, fontWeight: '600' },

  modalSection: { fontSize: 11, fontFamily: FONTS.semibold, fontWeight: '600', color: MUTED, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, marginTop: 4 },
  emptyHint:    { fontSize: 13, color: MUTED, fontStyle: 'italic', marginBottom: 12 },

  contactCard: { backgroundColor: SURFACE, borderRadius: 16, borderWidth: 1, borderColor: BORDER, padding: 14, marginBottom: 10 },
  contactCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  contactName: { fontSize: 15, color: TEXT, fontFamily: FONTS.semibold, fontWeight: '600' },
  viewProfile: { fontSize: 12, color: PURPLE, fontFamily: FONTS.medium, fontWeight: '500' },
  chipLabel: { fontSize: 11, color: MUTED, fontFamily: FONTS.medium, fontWeight: '500', marginBottom: 6, marginTop: 6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: BORDER, backgroundColor: SURFACE2 },
  chipActive: { borderColor: PURPLE, backgroundColor: PURPLE + '20' },
  chipText: { fontSize: 12, color: MUTED, fontFamily: FONTS.medium, fontWeight: '500' },
  chipTextActive: { color: PURPLE, fontFamily: FONTS.semibold, fontWeight: '600' },

  overlay: { flex: 1, backgroundColor: '#000000bb', justifyContent: 'flex-end' },
  sheet:   { backgroundColor: SURFACE, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: BORDER, borderBottomWidth: 0, maxHeight: '85%', paddingBottom: 8 },
  handle:  { width: 36, height: 4, backgroundColor: BORDER, borderRadius: 2, alignSelf: 'center', marginTop: 12, marginBottom: 4 },
  pickerTitle: { fontSize: 17, fontFamily: FONTS.bold, fontWeight: '700', color: TEXT, paddingHorizontal: 20, marginTop: 8 },
  pickerHint:  { fontSize: 12, color: MUTED, paddingHorizontal: 20, marginTop: 6, marginBottom: 14, lineHeight: 17 },
  declineRow: { marginHorizontal: 20, marginBottom: 10, backgroundColor: SURFACE2, borderWidth: 1, borderColor: BORDER, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  declineRowText: { fontSize: 13, color: MUTED, fontFamily: FONTS.semibold, fontWeight: '600' },
  createRow: { marginHorizontal: 20, marginBottom: 10, backgroundColor: CONTEXT + '15', borderWidth: 1, borderColor: CONTEXT + '40', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  createRowText: { fontSize: 13, color: CONTEXT, fontFamily: FONTS.semibold, fontWeight: '600' },
  pickerSearch: { marginHorizontal: 20, backgroundColor: SURFACE2, borderWidth: 1, borderColor: BORDER, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: TEXT, fontFamily: FONTS.regular, fontSize: 14, marginBottom: 10 },
  pickerList:  { maxHeight: 280, paddingHorizontal: 20 },
  pickerRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: BORDER },
  pickerRowName:   { flex: 1, fontSize: 14, color: TEXT, fontFamily: FONTS.medium, fontWeight: '500' },
  pickerRowAction: { fontSize: 13, color: PURPLE, fontFamily: FONTS.semibold, fontWeight: '600' },
  closeBtn:     { margin: 16, marginTop: 8, backgroundColor: SURFACE2, borderWidth: 1, borderColor: BORDER, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  closeBtnText: { fontSize: 15, fontFamily: FONTS.semibold, fontWeight: '600', color: MUTED },
});
