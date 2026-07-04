import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { UpcomingBookingItem, UpcomingCalendarItem, UpcomingData } from '../services/upcomingEvents';

const PURPLE  = '#6366f1';
const AMBER   = '#f59e0b';
const RED     = '#ef4444';
const BG      = '#0c0c0e';
const SURFACE = '#18181b';
const BORDER  = '#27272a';
const TEXT    = '#f4f4f5';
const MUTED   = '#71717a';

interface Props {
  upcomingData: UpcomingData;
  googleAuthed: boolean;
  gmailConnected: boolean;
  onGoToSettings: () => void;
}

function CalendarRow({ item }: { item: UpcomingCalendarItem }) {
  return (
    <View style={styles.item}>
      <View style={[styles.itemIcon, { backgroundColor: '#6366f115' }]}>
        <Text style={styles.itemIconText}>{item.icon}</Text>
      </View>
      <View style={styles.itemBody}>
        <Text style={styles.itemTitle} numberOfLines={1}>{item.title}</Text>
        <Text style={styles.itemSub}>{item.subtitle}</Text>
      </View>
      <View style={[styles.badge, { backgroundColor: '#6366f115' }]}>
        <Text style={[styles.badgeText, { color: PURPLE }]}>Cal</Text>
      </View>
    </View>
  );
}

function BookingRow({ item }: { item: UpcomingBookingItem }) {
  return (
    <View style={styles.item}>
      <View style={[styles.itemIcon, { backgroundColor: '#f59e0b15' }]}>
        <Text style={styles.itemIconText}>{item.icon}</Text>
      </View>
      <View style={styles.itemBody}>
        <Text style={styles.itemTitle} numberOfLines={1}>{item.title}</Text>
        <Text style={styles.itemSub}>{item.subtitle}</Text>
      </View>
      <View style={[styles.badge, { backgroundColor: '#f59e0b15' }]}>
        <Text style={[styles.badgeText, { color: AMBER }]}>Gmail</Text>
      </View>
    </View>
  );
}

function ItemRow({ item }: { item: UpcomingCalendarItem | UpcomingBookingItem }) {
  return item.kind === 'calendar' ? <CalendarRow item={item} /> : <BookingRow item={item} />;
}

const byDate = (a: { date: Date }, b: { date: Date }) => a.date.getTime() - b.date.getTime();

export default function UpcomingScreen({ upcomingData, googleAuthed, gmailConnected, onGoToSettings }: Props) {
  const { calendarItems, bookingItems } = upcomingData;
  // Bookings with a resolved future travel date (e.g. a parsed flight date) join the
  // Today/Tomorrow/Later timeline alongside calendar events; confirmations without one
  // stay in "Recent bookings" below, ordered by when the email arrived.
  const upcomingTravel = bookingItems.filter(b => b.isUpcomingTravel);
  const recentBookings = bookingItems.filter(b => !b.isUpcomingTravel);
  const merged = [...calendarItems, ...upcomingTravel];

  const today    = merged.filter(i => i.isToday).sort(byDate);
  const tomorrow = merged.filter(i => i.isTomorrow).sort(byDate);
  const later    = merged.filter(i => !i.isToday && !i.isTomorrow).sort(byDate);
  const isEmpty  = merged.length === 0 && recentBookings.length === 0;
  const notConnected = !googleAuthed && !gmailConnected;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Upcoming</Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
        {upcomingData.bookingsError && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerTitle}>Couldn't check Gmail for bookings</Text>
            <Text style={styles.errorBannerText}>{upcomingData.bookingsError}</Text>
          </View>
        )}

        {isEmpty && notConnected && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🗓</Text>
            <Text style={styles.emptyTitle}>Connect Calendar or Gmail</Text>
            <Text style={styles.emptySub}>Link Google Calendar and Gmail in Settings to see upcoming events and booking confirmations here.</Text>
            <Pressable style={styles.connectBtn} onPress={onGoToSettings}>
              <Text style={styles.connectBtnText}>Go to Settings</Text>
            </Pressable>
          </View>
        )}

        {isEmpty && !notConnected && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>✅</Text>
            <Text style={styles.emptyTitle}>Nothing upcoming</Text>
            <Text style={styles.emptySub}>Calendar events and booking confirmations from Gmail will show up here.</Text>
          </View>
        )}

        {today.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>TODAY</Text>
            {today.map(item => <ItemRow key={item.id} item={item} />)}
          </>
        )}

        {tomorrow.length > 0 && (
          <>
            <Text style={[styles.sectionLabel, { marginTop: 20 }]}>TOMORROW</Text>
            {tomorrow.map(item => <ItemRow key={item.id} item={item} />)}
          </>
        )}

        {later.length > 0 && (
          <>
            <Text style={[styles.sectionLabel, { marginTop: 20 }]}>LATER</Text>
            {later.map(item => <ItemRow key={item.id} item={item} />)}
          </>
        )}

        {recentBookings.length > 0 && (
          <>
            <Text style={[styles.sectionLabel, { marginTop: 20 }]}>RECENT BOOKINGS</Text>
            {recentBookings.map(item => <BookingRow key={item.id} item={item} />)}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  title:  { fontSize: 24, fontWeight: '700', color: TEXT, letterSpacing: -0.5 },

  list:        { flex: 1 },
  listContent: { padding: 16, paddingTop: 4, paddingBottom: 40 },

  sectionLabel: { fontSize: 11, fontWeight: '600', color: MUTED, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },

  errorBanner:      { backgroundColor: '#ef444415', borderWidth: 1, borderColor: '#ef444433', borderRadius: 14, padding: 12, marginBottom: 16 },
  errorBannerTitle: { fontSize: 13, fontWeight: '600', color: RED, marginBottom: 4 },
  errorBannerText:  { fontSize: 12, color: MUTED },

  item:     { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: SURFACE, borderRadius: 14, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: BORDER },
  itemIcon: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  itemIconText: { fontSize: 17 },
  itemBody: { flex: 1, minWidth: 0 },
  itemTitle: { fontSize: 15, color: TEXT, fontWeight: '400' },
  itemSub:   { fontSize: 12, color: MUTED, marginTop: 2 },
  badge:     { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 },
  badgeText: { fontSize: 11, fontWeight: '600' },

  emptyState:  { alignItems: 'center', paddingTop: 80, paddingHorizontal: 32 },
  emptyIcon:   { fontSize: 48, marginBottom: 16 },
  emptyTitle:  { fontSize: 18, fontWeight: '600', color: TEXT, marginBottom: 8 },
  emptySub:    { fontSize: 14, color: MUTED, textAlign: 'center', lineHeight: 20 },
  connectBtn:  { marginTop: 20, backgroundColor: PURPLE, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 24 },
  connectBtnText: { fontSize: 14, fontWeight: '600', color: '#fff' },
});
