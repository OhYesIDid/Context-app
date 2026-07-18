import React from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { FollowUp } from '../services/followUps';
import { deleteFollowUp, formatDueLabel, markDone, urgency } from '../services/followUps';
import { PURPLE, BG, SURFACE, BORDER, TEXT, MUTED, GREEN, AMBER, RED } from '../theme';

const URGENCY_COLOR: Record<string, string> = {
  overdue: RED, today: AMBER, soon: PURPLE, later: MUTED, none: BORDER,
};

interface Props {
  followUps: FollowUp[];
  setFollowUps: (items: FollowUp[]) => void;
  onGoToSettings: () => void;
}

export default function FollowUpsScreen({ followUps, setFollowUps, onGoToSettings }: Props) {
  const pending = followUps.filter(f => f.status === 'pending');
  const done    = followUps.filter(f => f.status === 'done');

  const sortedPending = [...pending].sort((a, b) => {
    const order = ['overdue', 'today', 'soon', 'later', 'none'];
    return order.indexOf(urgency(a)) - order.indexOf(urgency(b)) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity);
  });

  const handleDone = async (id: string) => {
    setFollowUps(await markDone(id));
  };

  const handleDelete = (id: string) => {
    Alert.alert('Remove follow-up', 'Delete this item?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { setFollowUps(await deleteFollowUp(id)); } },
    ]);
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Follow-ups</Text>
        <Pressable onPress={onGoToSettings} style={styles.settingsBtn}>
          <Text style={styles.settingsIcon}>⚙</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
        {sortedPending.length === 0 && done.length === 0 && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>☑</Text>
            <Text style={styles.emptyTitle}>No follow-ups yet</Text>
            <Text style={styles.emptySub}>When someone asks you to do something in a conversation, it'll appear here automatically.</Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },

  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  title:        { fontSize: 24, fontWeight: '700', color: TEXT, letterSpacing: -0.5 },
  settingsBtn:  { width: 36, height: 36, borderRadius: 12, backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, alignItems: 'center', justifyContent: 'center' },
  settingsIcon: { fontSize: 17, color: MUTED },

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
});
