import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { FollowUp } from '../services/followUps';
import { formatDueLabel, urgency } from '../services/followUps';

const PURPLE = '#6366f1';
const BG     = '#0c0c0e';
const SURFACE = '#18181b';
const BORDER  = '#27272a';
const TEXT    = '#f4f4f5';
const MUTED   = '#71717a';
const GREEN   = '#22c55e';
const AMBER   = '#f59e0b';
const RED     = '#ef4444';

const URGENCY_DOT: Record<string, string> = {
  overdue: RED,
  today:   AMBER,
  soon:    PURPLE,
  later:   MUTED,
  none:    BORDER,
};

const URGENCY_TIME: Record<string, string> = {
  overdue: RED,
  today:   AMBER,
  soon:    PURPLE,
  later:   MUTED,
  none:    MUTED,
};

interface Props {
  followUps: FollowUp[];
  onGoToFollowUps: () => void;
  onGoToSettings: () => void;
  onOpenPaywall: () => void;
  isPro: boolean;
}

export default function HomeScreen({ followUps, onGoToFollowUps, onGoToSettings, onOpenPaywall, isPro }: Props) {
  const pending = followUps.filter(f => f.status === 'pending');
  const sorted  = [...pending].sort((a, b) => {
    const ua = urgency(a); const ub = urgency(b);
    const order = ['overdue', 'today', 'soon', 'later', 'none'];
    return order.indexOf(ua) - order.indexOf(ub) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity);
  });
  const preview = sorted.slice(0, 3);

  const overdueCount = pending.filter(f => urgency(f) === 'overdue').length;
  const todayCount   = pending.filter(f => urgency(f) === 'today').length;

  // Today card items — dynamic, priority-ordered
  const todayItems: { icon: string; iconBg: string; title: string; sub: string; action?: string; onAction?: () => void }[] = [];
  if (overdueCount > 0) {
    todayItems.push({ icon: '⏰', iconBg: '#ef444420', title: `${overdueCount} overdue follow-up${overdueCount > 1 ? 's' : ''}`, sub: 'Action needed now', action: 'View', onAction: onGoToFollowUps });
  }
  if (todayCount > 0) {
    todayItems.push({ icon: '📋', iconBg: '#f59e0b20', title: `${todayCount} follow-up${todayCount > 1 ? 's' : ''} due today`, sub: sorted.filter(f => urgency(f) === 'today').map(f => f.contactName ?? f.text.slice(0, 20)).join(', '), action: 'View', onAction: onGoToFollowUps });
  }
  if (!isPro) {
    todayItems.push({ icon: '⭐', iconBg: '#6366f120', title: 'Upgrade to ConTxt Pro', sub: 'Suggestions for every message, not just ETA & plans', action: 'Upgrade', onAction: onOpenPaywall });
  }
  if (todayItems.length === 0) {
    todayItems.push({ icon: '✅', iconBg: '#22c55e20', title: 'You\'re all caught up', sub: 'No follow-ups due today' });
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Con<Text style={{ color: PURPLE }}>Txt</Text></Text>
        <Pressable onPress={onGoToSettings} style={styles.settingsBtn}>
          <Text style={styles.settingsIcon}>⚙</Text>
        </Pressable>
      </View>

      {/* Follow-ups card */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleRow}>
            <View style={[styles.cardIcon, { backgroundColor: '#6366f120' }]}>
              <Text style={styles.cardIconText}>📋</Text>
            </View>
            <Text style={styles.cardTitle}>Follow-ups</Text>
            {overdueCount > 0 && (
              <View style={[styles.badge, { backgroundColor: RED }]}>
                <Text style={styles.badgeText}>{overdueCount} overdue</Text>
              </View>
            )}
          </View>
          <Pressable onPress={onGoToFollowUps}>
            <Text style={styles.cardLink}>View all</Text>
          </Pressable>
        </View>
        <View style={styles.divider} />

        {pending.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No follow-ups yet</Text>
            <Text style={styles.emptySubText}>Add one when you make a commitment in a conversation</Text>
          </View>
        ) : (
          preview.map(f => {
            const u = urgency(f);
            const label = formatDueLabel(f);
            return (
              <Pressable key={f.id} style={styles.followupItem} onPress={onGoToFollowUps}>
                <View style={[styles.dot, { backgroundColor: URGENCY_DOT[u] }]} />
                <View style={styles.followupContent}>
                  <Text style={[styles.followupText, u === 'overdue' && { color: '#fca5a5' }]} numberOfLines={1}>{f.text}</Text>
                  {(f.contactName || f.appName) && (
                    <Text style={styles.followupMeta}>{[f.contactName, f.appName].filter(Boolean).join(' · ')}</Text>
                  )}
                </View>
                {label ? <Text style={[styles.followupTime, { color: URGENCY_TIME[u] }]}>{label}</Text> : null}
              </Pressable>
            );
          })
        )}

        <View style={styles.cardFooter}>
          <Text style={styles.footerText}>{pending.length} pending{pending.length !== followUps.length ? ` · ${followUps.filter(f => f.status === 'done').length} done` : ''}</Text>
          <Pressable style={styles.addBtn} onPress={onGoToFollowUps}>
            <Text style={styles.addBtnText}>+ Add</Text>
          </Pressable>
        </View>
      </View>

      {/* Today card */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleRow}>
            <View style={[styles.cardIcon, { backgroundColor: '#f59e0b20' }]}>
              <Text style={styles.cardIconText}>☀️</Text>
            </View>
            <Text style={styles.cardTitle}>Today</Text>
          </View>
        </View>
        <View style={styles.divider} />

        {todayItems.map((item, i) => (
          <View key={i} style={styles.todayItem}>
            <View style={[styles.todayIcon, { backgroundColor: item.iconBg }]}>
              <Text style={styles.todayIconText}>{item.icon}</Text>
            </View>
            <View style={styles.todayBody}>
              <Text style={styles.todayTitle}>{item.title}</Text>
              {item.sub ? <Text style={styles.todaySub} numberOfLines={1}>{item.sub}</Text> : null}
            </View>
            {item.action && item.onAction && (
              <Pressable style={styles.todayAction} onPress={item.onAction}>
                <Text style={styles.todayActionText}>{item.action}</Text>
              </Pressable>
            )}
          </View>
        ))}
      </View>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: BG },
  content: { padding: 16, paddingTop: 8, paddingBottom: 32 },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, paddingHorizontal: 4 },
  title:  { fontSize: 28, fontWeight: '700', color: TEXT, letterSpacing: -0.5 },
  settingsBtn:  { width: 36, height: 36, borderRadius: 12, backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, alignItems: 'center', justifyContent: 'center' },
  settingsIcon: { fontSize: 17, color: MUTED },

  card:       { backgroundColor: SURFACE, borderRadius: 18, borderWidth: 1, borderColor: BORDER, marginBottom: 12, overflow: 'hidden' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardIcon:    { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  cardIconText: { fontSize: 16 },
  cardTitle:   { fontSize: 15, fontWeight: '600', color: TEXT },
  cardLink:    { fontSize: 13, color: PURPLE, fontWeight: '600' },
  divider:     { height: 1, backgroundColor: BORDER, marginHorizontal: 14 },

  badge:     { borderRadius: 20, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: '700', color: '#fff' },

  emptyState:   { padding: 20, alignItems: 'center' },
  emptyText:    { color: MUTED, fontSize: 14, fontWeight: '500' },
  emptySubText: { color: MUTED, fontSize: 12, marginTop: 4, textAlign: 'center', lineHeight: 18 },

  followupItem:    { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 14 },
  dot:             { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  followupContent: { flex: 1, minWidth: 0 },
  followupText:    { fontSize: 14, color: TEXT, fontWeight: '400' },
  followupMeta:    { fontSize: 12, color: MUTED, marginTop: 1 },
  followupTime:    { fontSize: 12, fontWeight: '600', flexShrink: 0 },

  cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, paddingHorizontal: 14, borderTopWidth: 1, borderTopColor: BORDER },
  footerText: { fontSize: 12, color: MUTED },
  addBtn:     { flexDirection: 'row', alignItems: 'center', backgroundColor: BORDER, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  addBtnText: { fontSize: 13, color: MUTED, fontWeight: '500' },

  todayItem:     { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 14 },
  todayIcon:     { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  todayIconText: { fontSize: 16 },
  todayBody:     { flex: 1, minWidth: 0 },
  todayTitle:    { fontSize: 14, color: TEXT, fontWeight: '400' },
  todaySub:      { fontSize: 12, color: MUTED, marginTop: 2 },
  todayAction:   { backgroundColor: BORDER, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, flexShrink: 0 },
  todayActionText: { fontSize: 12, color: MUTED, fontWeight: '500' },

});
