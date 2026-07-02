import React, { useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { FollowUp } from '../services/followUps';
import { addFollowUp, deleteFollowUp, formatDueLabel, markDone, urgency } from '../services/followUps';

const PURPLE = '#6366f1';
const BG     = '#0c0c0e';
const SURFACE = '#18181b';
const BORDER  = '#27272a';
const TEXT    = '#f4f4f5';
const MUTED   = '#71717a';
const GREEN   = '#22c55e';
const AMBER   = '#f59e0b';
const RED     = '#ef4444';

const DUE_OPTIONS = [
  { label: 'Today',      offset: () => { const d = new Date(); d.setHours(18, 0, 0, 0); return d.getTime(); } },
  { label: 'Tomorrow',   offset: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d.getTime(); } },
  { label: 'This week',  offset: () => { const d = new Date(); const day = d.getDay(); const daysUntilFri = (5 - day + 7) % 7 || 7; d.setDate(d.getDate() + daysUntilFri); d.setHours(10, 0, 0, 0); return d.getTime(); } },
  { label: 'Next week',  offset: () => { const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(10, 0, 0, 0); return d.getTime(); } },
  { label: 'Someday',    offset: () => undefined as unknown as number },
];

const URGENCY_COLOR: Record<string, string> = {
  overdue: RED, today: AMBER, soon: PURPLE, later: MUTED, none: BORDER,
};

interface Props {
  followUps: FollowUp[];
  setFollowUps: (items: FollowUp[]) => void;
}

export default function FollowUpsScreen({ followUps, setFollowUps }: Props) {
  const [addVisible, setAddVisible] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [draftContact, setDraftContact] = useState('');
  const [draftDueIdx, setDraftDueIdx] = useState(0); // index into DUE_OPTIONS
  const [saving, setSaving] = useState(false);

  const pending = followUps.filter(f => f.status === 'pending');
  const done    = followUps.filter(f => f.status === 'done');

  const sortedPending = [...pending].sort((a, b) => {
    const order = ['overdue', 'today', 'soon', 'later', 'none'];
    return order.indexOf(urgency(a)) - order.indexOf(urgency(b)) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity);
  });

  const handleAdd = async () => {
    const text = draftText.trim();
    if (!text) return;
    setSaving(true);
    try {
      const dueAt = DUE_OPTIONS[draftDueIdx].offset();
      const next = await addFollowUp({ text, contactName: draftContact.trim() || undefined, dueAt: dueAt || undefined });
      setFollowUps(next);
      setAddVisible(false);
      setDraftText('');
      setDraftContact('');
      setDraftDueIdx(0);
    } finally {
      setSaving(false);
    }
  };

  const handleDone = async (id: string) => {
    const next = await markDone(id);
    setFollowUps(next);
  };

  const handleDelete = (id: string) => {
    Alert.alert('Remove follow-up', 'Delete this item?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { setFollowUps(await deleteFollowUp(id)); } },
    ]);
  };

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Follow-ups</Text>
        <Pressable style={styles.addHeaderBtn} onPress={() => setAddVisible(true)}>
          <Text style={styles.addHeaderText}>+ Add</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
        {sortedPending.length === 0 && done.length === 0 && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>☑</Text>
            <Text style={styles.emptyTitle}>No follow-ups</Text>
            <Text style={styles.emptySub}>When you commit to doing something in a conversation, save it here so you don't forget.</Text>
            <Pressable style={styles.emptyBtn} onPress={() => setAddVisible(true)}>
              <Text style={styles.emptyBtnText}>Add your first follow-up</Text>
            </Pressable>
          </View>
        )}

        {sortedPending.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>PENDING</Text>
            {sortedPending.map(f => {
              const u = urgency(f);
              const label = formatDueLabel(f);
              return (
                <View key={f.id} style={styles.item}>
                  <Pressable style={styles.checkBtn} onPress={() => handleDone(f.id)}>
                    <View style={styles.checkCircle} />
                  </Pressable>
                  <View style={styles.itemContent}>
                    <Text style={[styles.itemText, u === 'overdue' && { color: '#fca5a5' }]}>{f.text}</Text>
                    <View style={styles.itemMeta}>
                      {f.contactName ? <Text style={styles.metaTag}>{f.contactName}</Text> : null}
                      {f.appName ? <Text style={styles.metaTag}>{f.appName}</Text> : null}
                      {label ? (
                        <Text style={[styles.metaDue, { color: URGENCY_COLOR[u] }]}>{label}</Text>
                      ) : null}
                    </View>
                  </View>
                  <Pressable onPress={() => handleDelete(f.id)} hitSlop={12}>
                    <Text style={styles.deleteBtn}>✕</Text>
                  </Pressable>
                </View>
              );
            })}
          </>
        )}

        {done.length > 0 && (
          <>
            <Text style={[styles.sectionLabel, { marginTop: 24 }]}>DONE</Text>
            {done.slice(0, 10).map(f => (
              <View key={f.id} style={[styles.item, { opacity: 0.5 }]}>
                <View style={[styles.checkBtn]}>
                  <View style={[styles.checkCircle, styles.checkCircleDone]}>
                    <Text style={styles.checkMark}>✓</Text>
                  </View>
                </View>
                <View style={styles.itemContent}>
                  <Text style={[styles.itemText, { textDecorationLine: 'line-through', color: MUTED }]}>{f.text}</Text>
                  {f.contactName ? <Text style={styles.metaTag}>{f.contactName}</Text> : null}
                </View>
                <Pressable onPress={() => handleDelete(f.id)} hitSlop={12}>
                  <Text style={styles.deleteBtn}>✕</Text>
                </Pressable>
              </View>
            ))}
          </>
        )}
      </ScrollView>

      {/* Add modal */}
      <Modal visible={addVisible} transparent animationType="slide" onRequestClose={() => setAddVisible(false)}>
        <Pressable style={styles.overlay} onPress={() => setAddVisible(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Add follow-up</Text>

            <Text style={styles.fieldLabel}>WHAT DO YOU NEED TO DO?</Text>
            <TextInput
              style={styles.textInput}
              placeholder="e.g. Send Sarah the doc link"
              placeholderTextColor={MUTED}
              value={draftText}
              onChangeText={setDraftText}
              autoFocus
              multiline
              numberOfLines={2}
            />

            <Text style={styles.fieldLabel}>CONTACT (OPTIONAL)</Text>
            <TextInput
              style={[styles.textInput, { marginBottom: 20 }]}
              placeholder="Who is it for?"
              placeholderTextColor={MUTED}
              value={draftContact}
              onChangeText={setDraftContact}
              autoCapitalize="words"
            />

            <Text style={styles.fieldLabel}>DUE</Text>
            <View style={styles.dueChips}>
              {DUE_OPTIONS.map((opt, i) => (
                <Pressable
                  key={opt.label}
                  style={[styles.dueChip, draftDueIdx === i && styles.dueChipActive]}
                  onPress={() => setDraftDueIdx(i)}
                >
                  <Text style={[styles.dueChipText, draftDueIdx === i && styles.dueChipTextActive]}>{opt.label}</Text>
                </Pressable>
              ))}
            </View>

            <Pressable
              style={[styles.saveBtn, (!draftText.trim() || saving) && { opacity: 0.5 }]}
              onPress={handleAdd}
              disabled={!draftText.trim() || saving}
            >
              <Text style={styles.saveBtnText}>{saving ? 'Saving…' : 'Save follow-up'}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },

  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  title:        { fontSize: 24, fontWeight: '700', color: TEXT, letterSpacing: -0.5 },
  addHeaderBtn: { backgroundColor: PURPLE, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 7 },
  addHeaderText:{ fontSize: 14, fontWeight: '600', color: '#fff' },

  list:        { flex: 1 },
  listContent: { padding: 16, paddingTop: 4, paddingBottom: 40 },

  sectionLabel: { fontSize: 11, fontWeight: '600', color: MUTED, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, marginTop: 4 },

  item:        { flexDirection: 'row', alignItems: 'flex-start', gap: 12, backgroundColor: SURFACE, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: BORDER },
  checkBtn:    { paddingTop: 1 },
  checkCircle: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: BORDER, alignItems: 'center', justifyContent: 'center' },
  checkCircleDone: { backgroundColor: GREEN, borderColor: GREEN },
  checkMark:   { color: '#fff', fontSize: 12, fontWeight: '700' },

  itemContent: { flex: 1, minWidth: 0 },
  itemText:    { fontSize: 15, color: TEXT, fontWeight: '400', lineHeight: 21 },
  itemMeta:    { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  metaTag:     { fontSize: 11, color: MUTED, backgroundColor: BORDER, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  metaDue:     { fontSize: 11, fontWeight: '600' },
  deleteBtn:   { fontSize: 14, color: MUTED, paddingTop: 2 },

  emptyState:  { alignItems: 'center', paddingTop: 80, paddingHorizontal: 32 },
  emptyIcon:   { fontSize: 48, marginBottom: 16 },
  emptyTitle:  { fontSize: 18, fontWeight: '600', color: TEXT, marginBottom: 8 },
  emptySub:    { fontSize: 14, color: MUTED, textAlign: 'center', lineHeight: 20 },
  emptyBtn:    { marginTop: 24, backgroundColor: PURPLE, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12 },
  emptyBtnText:{ fontSize: 15, fontWeight: '600', color: '#fff' },

  overlay: { flex: 1, backgroundColor: '#000000aa', justifyContent: 'flex-end' },
  sheet:   { backgroundColor: '#1c1c1e', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 },
  handle:  { width: 36, height: 4, backgroundColor: BORDER, borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
  sheetTitle: { fontSize: 18, fontWeight: '700', color: TEXT, marginBottom: 20 },

  fieldLabel: { fontSize: 11, fontWeight: '600', color: MUTED, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
  textInput:  { backgroundColor: BORDER, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: TEXT, marginBottom: 20, textAlignVertical: 'top' },

  dueChips:    { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 24 },
  dueChip:     { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: BORDER, backgroundColor: SURFACE },
  dueChipActive:    { borderColor: PURPLE, backgroundColor: '#6366f120' },
  dueChipText:      { fontSize: 14, color: MUTED },
  dueChipTextActive:{ color: PURPLE, fontWeight: '600' },

  saveBtn:     { backgroundColor: PURPLE, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  saveBtnText: { fontSize: 16, fontWeight: '600', color: '#fff' },
});
