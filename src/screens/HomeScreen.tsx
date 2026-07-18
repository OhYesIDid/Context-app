import React, { useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { FollowUp } from '../services/followUps';
import { formatDueLabel, urgency } from '../services/followUps';
import { clearPendingCalendarAction, formatCalendarLabel } from '../services/pendingCalendarActions';
import type { PendingCalendarAction } from '../services/pendingCalendarActions';
import { clearPendingFollowUp } from '../services/pendingFollowUps';
import type { PendingFollowUp } from '../services/pendingFollowUps';
import type { UpcomingData } from '../services/upcomingEvents';
import { PURPLE, BG, SURFACE, BORDER, TEXT, MUTED, GREEN, AMBER, RED, CONTEXT, FONTS } from '../theme';

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

interface StyleStats {
  editCount: number;
  contactsMatched: number;
  hasProfile: boolean;
}

interface Props {
  followUps: FollowUp[];
  pendingCalendarActions: PendingCalendarAction[];
  pendingFollowUps: PendingFollowUp[];
  upcomingData: UpcomingData;
  styleStats: StyleStats | null;
  onCalendarActionDismiss: (id: string) => void;
  onFollowUpAdd: (item: PendingFollowUp) => void;
  onFollowUpDismiss: (id: string) => void;
  onGoToFollowUps: () => void;
  onGoToSettings: () => void;
  onOpenPaywall: () => void;
  isPro: boolean;
  missingPermissions: string[];
}

export default function HomeScreen({ followUps, pendingCalendarActions, pendingFollowUps, upcomingData, styleStats, onCalendarActionDismiss, onFollowUpAdd, onFollowUpDismiss, onGoToFollowUps, onGoToSettings, onOpenPaywall, isPro, missingPermissions }: Props) {
  const [upcomingExpanded, setUpcomingExpanded] = useState(false);
  const pending = followUps.filter(f => f.status === 'pending');
  const sorted  = [...pending].sort((a, b) => {
    const ua = urgency(a); const ub = urgency(b);
    const order = ['overdue', 'today', 'soon', 'later', 'none'];
    return order.indexOf(ua) - order.indexOf(ub) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity);
  });
  const preview = sorted.slice(0, 3);

  const overdueCount = pending.filter(f => urgency(f) === 'overdue').length;
  const todayCount   = pending.filter(f => urgency(f) === 'today').length;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Con<Text style={{ color: PURPLE }}>Txt</Text></Text>
        <Pressable onPress={onGoToSettings} style={styles.settingsBtn}>
          <Text style={styles.settingsIcon}>⚙</Text>
        </Pressable>
      </View>

      {/* Setup incomplete — only shown when something's missing, so it never nags a fully-configured user */}
      {missingPermissions.length > 0 && (
        <Pressable style={styles.setupBanner} onPress={onGoToSettings}>
          <Text style={styles.setupBannerIcon}>⚠</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.setupBannerTitle}>Finish setup for the full experience</Text>
            <Text style={styles.setupBannerSub}>{missingPermissions.join(' · ')}</Text>
          </View>
          <Text style={styles.setupBannerAction}>Fix</Text>
        </Pressable>
      )}

      {/* Status strip — one glanceable line instead of a stacked "Today" card,
          same underlying overdue/today counts. Style stat folds in here as a
          pill instead of its own full card. */}
      <View style={styles.statusStrip}>
        <View style={[styles.statusDot, { backgroundColor: overdueCount > 0 ? RED : todayCount > 0 ? AMBER : GREEN }]} />
        <Text style={styles.statusText} numberOfLines={1}>
          {overdueCount > 0 ? `${overdueCount} overdue` : todayCount > 0 ? `${todayCount} due today` : 'All caught up'}
          {overdueCount > 0 && todayCount > 0 && <Text style={styles.statusTextMuted}> · {todayCount} due today</Text>}
        </Text>
        {styleStats?.hasProfile && (
          <View style={styles.stylePill}>
            <Text style={styles.stylePillText}>{styleStats.editCount} LEARNED</Text>
          </View>
        )}
      </View>

      {/* Pro upsell — separate from the setup banner above; different nudge, different fix */}
      {!isPro && (
        <Pressable style={styles.proNudge} onPress={onOpenPaywall}>
          <Text style={styles.proNudgeText}>Suggestions for every message, not just ETA & plans</Text>
          <Text style={styles.proNudgeAction}>Upgrade</Text>
        </Pressable>
      )}

      {/* Follow-ups — confirmed + AI-suggested merged into one card, tagged not duplicated */}
      {(pending.length > 0 || pendingFollowUps.length > 0) && (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleRow}>
              <View style={[styles.cardIcon, { backgroundColor: '#e2933c20' }]}>
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

          {preview.slice(0, 2).map(f => {
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
          })}

          {pendingFollowUps.slice(0, 2).map(item => (
            <View key={item.id} style={styles.calendarItem}>
              <View style={styles.calendarBody}>
                <View style={styles.suggestedRow}>
                  <Text style={styles.calendarTitle} numberOfLines={1}>{item.task}</Text>
                  <View style={styles.suggestedTag}><Text style={styles.suggestedTagText}>SUGGESTED</Text></View>
                </View>
                <Text style={styles.calendarSub}>
                  {[item.contactName ? `from ${item.contactName}` : null, item.dueHint].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <View style={styles.calendarActions}>
                <Pressable
                  style={styles.calendarAddBtn}
                  onPress={() => {
                    clearPendingFollowUp(item.id);
                    onFollowUpAdd(item);
                  }}
                >
                  <Text style={styles.calendarAddText}>Add</Text>
                </Pressable>
                <Pressable
                  hitSlop={10}
                  onPress={() => { clearPendingFollowUp(item.id); onFollowUpDismiss(item.id); }}
                >
                  <Text style={styles.calendarDismiss}>✕</Text>
                </Pressable>
              </View>
            </View>
          ))}

          <View style={styles.cardFooter}>
            <Text style={styles.footerText}>
              {pending.length} pending{pendingFollowUps.length > 0 ? ` · ${pendingFollowUps.length} suggested` : ''}
            </Text>
          </View>
        </View>
      )}

      {/* Upcoming — suggested calendar events + confirmed calendar/bookings merged */}
      {(pendingCalendarActions.length > 0 || upcomingData.calendarItems.length > 0 || upcomingData.bookingItems.length > 0) && (() => {
        // Anything with a real date (calendar events + bookings with a resolved travel
        // date) sorts chronologically first; confirmations with no known travel date
        // (just "confirmed N days ago") are appended after.
        const dated = [
          ...upcomingData.calendarItems.map(i => ({ ...i, source: 'cal' as const })),
          ...upcomingData.bookingItems.filter(b => b.isUpcomingTravel).map(i => ({ ...i, source: 'gmail' as const })),
        ].sort((a, b) => a.date.getTime() - b.date.getTime());
        const recent = upcomingData.bookingItems.filter(b => !b.isUpcomingTravel).map(i => ({ ...i, source: 'gmail' as const }));
        const allItems = [...dated, ...recent];
        const PREVIEW_COUNT = 5;
        const shown = upcomingExpanded ? allItems : allItems.slice(0, PREVIEW_COUNT);
        const hiddenCount = allItems.length - PREVIEW_COUNT;
        const totalCount = allItems.length + pendingCalendarActions.length;
        return (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={styles.cardTitleRow}>
                <View style={[styles.cardIcon, { backgroundColor: '#f59e0b20' }]}>
                  <Text style={styles.cardIconText}>🗓</Text>
                </View>
                <Text style={styles.cardTitle}>Upcoming</Text>
                {totalCount > 0 && (
                  <View style={[styles.badge, { backgroundColor: '#f59e0b1a', borderWidth: 1, borderColor: '#f59e0b33' }]}>
                    <Text style={[styles.badgeText, { color: AMBER }]}>{totalCount}</Text>
                  </View>
                )}
              </View>
            </View>
            <View style={styles.divider} />

            {pendingCalendarActions.map(action => (
              <View key={action.id} style={styles.calendarItem}>
                <View style={styles.calendarBody}>
                  <View style={styles.suggestedRow}>
                    <Text style={styles.calendarTitle} numberOfLines={1}>{action.title}</Text>
                    <View style={styles.suggestedTag}><Text style={styles.suggestedTagText}>SUGGESTED</Text></View>
                  </View>
                  <Text style={styles.calendarSub}>
                    {action.contactName ? `with ${action.contactName}` : ''}
                    {action.contactName && action.datetime ? ' · ' : ''}
                    {action.datetime ? formatCalendarLabel(action) : 'Time TBD'}
                  </Text>
                </View>
                <View style={styles.calendarActions}>
                  <Pressable
                    style={styles.calendarAddBtn}
                    onPress={() => {
                      const title = encodeURIComponent(action.title);
                      const dtStr = action.datetime ? `&dates=${action.datetime.replace(/[-:]/g, '').replace('T', 'T')}` : '';
                      Linking.openURL(`https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}${dtStr}`).catch(() => {});
                      clearPendingCalendarAction(action.id);
                      onCalendarActionDismiss(action.id);
                    }}
                  >
                    <Text style={styles.calendarAddText}>Add</Text>
                  </Pressable>
                  <Pressable
                    hitSlop={10}
                    onPress={() => { clearPendingCalendarAction(action.id); onCalendarActionDismiss(action.id); }}
                  >
                    <Text style={styles.calendarDismiss}>✕</Text>
                  </Pressable>
                </View>
              </View>
            ))}

            {shown.map(item => (
              <View key={item.id} style={styles.upcomingItem}>
                <View style={[styles.upcomingIcon, { backgroundColor: item.source === 'cal' ? '#e2933c15' : '#f59e0b15' }]}>
                  <Text style={styles.upcomingIconText}>{item.icon}</Text>
                </View>
                <View style={styles.upcomingBody}>
                  <Text style={styles.upcomingTitle} numberOfLines={1}>{item.title}</Text>
                  <Text style={styles.upcomingSub}>{item.subtitle}</Text>
                </View>
                <View style={[styles.upcomingBadge, { backgroundColor: item.source === 'cal' ? '#e2933c15' : '#f59e0b15' }]}>
                  <Text style={[styles.upcomingBadgeText, { color: item.source === 'cal' ? PURPLE : AMBER }]}>
                    {item.source === 'cal' ? 'Cal' : 'Gmail'}
                  </Text>
                </View>
              </View>
            ))}

            {!upcomingExpanded && hiddenCount > 0 && (
              <Pressable style={styles.showMoreBtn} onPress={() => setUpcomingExpanded(true)}>
                <Text style={styles.showMoreText}>{hiddenCount} more…</Text>
              </Pressable>
            )}
            {upcomingExpanded && allItems.length > PREVIEW_COUNT && (
              <Pressable style={styles.showMoreBtn} onPress={() => setUpcomingExpanded(false)}>
                <Text style={styles.showMoreText}>Show less</Text>
              </Pressable>
            )}
          </View>
        );
      })()}

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: BG },
  content: { padding: 16, paddingTop: 8, paddingBottom: 32 },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, paddingHorizontal: 4 },
  title:  { fontSize: 28, fontFamily: FONTS.bold, fontWeight: '700', color: TEXT, letterSpacing: -0.5 },
  settingsBtn:  { width: 36, height: 36, borderRadius: 12, backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, alignItems: 'center', justifyContent: 'center' },
  settingsIcon: { fontSize: 17, color: MUTED },

  setupBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: AMBER + '15', borderRadius: 14, borderWidth: 1, borderColor: AMBER + '40', padding: 12, marginBottom: 12 },
  setupBannerIcon: { fontSize: 16, color: AMBER },
  setupBannerTitle: { fontSize: 13, fontFamily: FONTS.semibold, fontWeight: '600', color: TEXT },
  setupBannerSub: { fontSize: 11, color: MUTED, marginTop: 2 },
  setupBannerAction: { fontSize: 13, fontFamily: FONTS.semibold, fontWeight: '600', color: AMBER },

  card:       { backgroundColor: SURFACE, borderRadius: 18, borderWidth: 1, borderColor: BORDER, marginBottom: 12, overflow: 'hidden' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardIcon:    { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  cardIconText: { fontSize: 16 },
  cardTitle:   { fontSize: 15, fontFamily: FONTS.semibold, fontWeight: '600', color: TEXT },
  cardLink:    { fontSize: 13, color: PURPLE, fontFamily: FONTS.semibold, fontWeight: '600' },
  divider:     { height: 1, backgroundColor: BORDER, marginHorizontal: 14 },

  badge:     { borderRadius: 20, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontFamily: FONTS.bold, fontWeight: '700', color: '#fff' },

  followupItem:    { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 14 },
  dot:             { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  followupContent: { flex: 1, minWidth: 0 },
  followupText:    { fontSize: 14, color: TEXT, fontWeight: '400' },
  followupMeta:    { fontSize: 12, color: MUTED, marginTop: 1 },
  followupTime:    { fontSize: 12, fontFamily: FONTS.monoSemibold, fontWeight: '600', flexShrink: 0 },

  cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, paddingHorizontal: 14, borderTopWidth: 1, borderTopColor: BORDER },
  footerText: { fontSize: 12, color: MUTED },
  addBtn:     { flexDirection: 'row', alignItems: 'center', backgroundColor: BORDER, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  addBtnText: { fontSize: 13, color: MUTED, fontFamily: FONTS.medium, fontWeight: '500' },

  statusStrip: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: SURFACE, borderRadius: 16, borderTopLeftRadius: 6, borderWidth: 1, borderColor: BORDER, padding: 14, marginBottom: 12 },
  statusDot:   { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  statusText:  { fontSize: 14, fontFamily: FONTS.semibold, fontWeight: '600', color: TEXT, flexShrink: 1 },
  statusTextMuted: { fontWeight: '400', color: MUTED },
  stylePill:      { marginLeft: 'auto', borderWidth: 1, borderColor: CONTEXT + '66', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 },
  stylePillText:  { fontSize: 9.5, fontWeight: '600', color: CONTEXT, fontFamily: FONTS.mono, letterSpacing: 0.4 },

  proNudge:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, backgroundColor: '#e2933c12', borderRadius: 14, borderWidth: 1, borderColor: '#e2933c33', padding: 12, marginBottom: 12 },
  proNudgeText:   { flex: 1, fontSize: 12.5, color: TEXT },
  proNudgeAction: { fontSize: 13, fontFamily: FONTS.bold, fontWeight: '700', color: PURPLE },

  suggestedRow:     { flexDirection: 'row', alignItems: 'center', gap: 6 },
  suggestedTag:     { borderWidth: 1, borderColor: CONTEXT + '55', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1.5, flexShrink: 0 },
  suggestedTagText: { fontSize: 8.5, fontFamily: FONTS.semibold, fontWeight: '600', color: CONTEXT, letterSpacing: 0.3 },

  calendarItem:    { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 14 },
  calendarBody:    { flex: 1, minWidth: 0 },
  calendarTitle:   { fontSize: 14, color: TEXT, fontFamily: FONTS.medium, fontWeight: '500' },
  calendarSub:     { fontSize: 12, color: MUTED, marginTop: 2 },
  calendarActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  calendarAddBtn:  { backgroundColor: '#e2933c22', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: '#e2933c44' },
  calendarAddText: { fontSize: 12, color: PURPLE, fontFamily: FONTS.semibold, fontWeight: '600' },
  calendarDismiss: { fontSize: 14, color: MUTED, paddingHorizontal: 4 },

  upcomingItem:      { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 14 },
  upcomingIcon:      { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  upcomingIconText:  { fontSize: 16 },
  upcomingBody:      { flex: 1, minWidth: 0 },
  upcomingTitle:     { fontSize: 14, color: TEXT, fontWeight: '400' },
  upcomingSub:       { fontSize: 12, color: MUTED, marginTop: 2 },
  upcomingBadge:     { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 },
  upcomingBadgeText: { fontSize: 11, fontFamily: FONTS.semibold, fontWeight: '600' },
  showMoreBtn:       { paddingVertical: 10, paddingHorizontal: 14, borderTopWidth: 1, borderTopColor: BORDER },
  showMoreText:      { fontSize: 13, color: PURPLE, fontFamily: FONTS.medium, fontWeight: '500' },

});
