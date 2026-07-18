import React, { useState } from 'react';
import { Linking, NativeModules, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Trip, UpcomingBookingItem, UpcomingCalendarItem, UpcomingData } from '../services/upcomingEvents';
import { formatTripDateRange } from '../services/upcomingEvents';
import { PURPLE, AMBER, RED, BG, SURFACE, BORDER, TEXT, MUTED, FONTS } from '../theme';

interface Props {
  upcomingData: UpcomingData;
  googleAuthed: boolean;
  onGoToSettings: () => void;
}

function CalendarRow({ item }: { item: UpcomingCalendarItem }) {
  return (
    <View style={styles.item}>
      <View style={[styles.itemIcon, { backgroundColor: '#e2933c15' }]}>
        <Text style={styles.itemIconText}>{item.icon}</Text>
      </View>
      <View style={styles.itemBody}>
        <Text style={styles.itemTitle} numberOfLines={1}>{item.title}</Text>
        <Text style={styles.itemSub}>{item.subtitle}</Text>
      </View>
      <View style={[styles.badge, { backgroundColor: '#e2933c15' }]}>
        <Text style={[styles.badgeText, { color: PURPLE }]}>Cal</Text>
      </View>
    </View>
  );
}

function openInGmail(gmailId: string) {
  const url = `https://mail.google.com/mail/u/0/#all/${gmailId}`;
  // Plain Linking.openURL() resolves this to the device's default browser,
  // not Gmail — mail.google.com isn't even in Gmail's declared App Link
  // domains on Android, so there's no "open by default" setting to fix it
  // either. openUrlInGmail explicitly targets Gmail's package, falling
  // back to normal resolution if Gmail isn't installed.
  const openInApp = NativeModules.ProTxtSettings?.openUrlInGmail as ((url: string) => Promise<boolean>) | undefined;
  if (openInApp) openInApp(url).catch(() => {});
  else Linking.openURL(url).catch(() => {});
}

function BookingRow({ item }: { item: UpcomingBookingItem }) {
  return (
    <Pressable style={styles.item} onPress={() => openInGmail(item.gmailId)}>
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
    </Pressable>
  );
}

function TripCard({ trip }: { trip: Trip }) {
  const [expanded, setExpanded] = useState(false);
  const dateRange = formatTripDateRange(trip.startDate, trip.endDate);
  const dayLabel = trip.isToday ? 'Today · ' : trip.isTomorrow ? 'Tomorrow · ' : '';

  return (
    <Pressable style={styles.tripCard} onPress={() => setExpanded(v => !v)}>
      <View style={styles.tripHeader}>
        <View style={[styles.itemIcon, { backgroundColor: '#e2933c15' }]}>
          <Text style={styles.itemIconText}>🧳</Text>
        </View>
        <View style={styles.itemBody}>
          <Text style={styles.itemTitle} numberOfLines={1}>{trip.destination}</Text>
          <Text style={styles.itemSub}>{dayLabel}{dateRange} · {trip.items.length} booking{trip.items.length === 1 ? '' : 's'}</Text>
        </View>
        <Text style={styles.chevron}>{expanded ? '⌄' : '›'}</Text>
      </View>
      {expanded && (
        <View style={styles.tripItems}>
          {trip.items.map(item => <BookingRow key={item.id} item={item} />)}
        </View>
      )}
    </Pressable>
  );
}

function ItemRow({ item }: { item: UpcomingCalendarItem | UpcomingBookingItem }) {
  return item.kind === 'calendar' ? <CalendarRow item={item} /> : <BookingRow item={item} />;
}

const byDate = (a: { date: Date }, b: { date: Date }) => a.date.getTime() - b.date.getTime();

export default function UpcomingScreen({ upcomingData, googleAuthed, onGoToSettings }: Props) {
  const { calendarItems, bookingItems, trips } = upcomingData;
  // Bookings with a resolved future travel date are grouped into trip cards
  // (below); calendar events keep their own Today/Tomorrow/Later timeline.
  // Confirmations without a resolved date stay in "Recent bookings" below.
  const recentBookings = bookingItems.filter(b => !b.isUpcomingTravel);

  const today    = calendarItems.filter(i => i.isToday).sort(byDate);
  const tomorrow = calendarItems.filter(i => i.isTomorrow).sort(byDate);
  const later    = calendarItems.filter(i => !i.isToday && !i.isTomorrow).sort(byDate);
  const isEmpty  = calendarItems.length === 0 && trips.length === 0 && recentBookings.length === 0;
  const notConnected = !googleAuthed;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>Upcoming</Text>
          {upcomingData.isSyncing && <Text style={styles.syncingHint}>Updating…</Text>}
        </View>
        <Pressable onPress={onGoToSettings} style={styles.settingsBtn}>
          <Text style={styles.settingsIcon}>⚙</Text>
        </Pressable>
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
            <Text style={styles.emptyTitle}>Sign in with Google</Text>
            <Text style={styles.emptySub}>Sign in with Google in Settings to see upcoming calendar events and booking confirmations here.</Text>
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

        {trips.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>TRIPS</Text>
            {trips.map(trip => <TripCard key={trip.id} trip={trip} />)}
          </>
        )}

        {today.length > 0 && (
          <>
            <Text style={[styles.sectionLabel, { marginTop: trips.length > 0 ? 20 : 0 }]}>TODAY</Text>
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

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  title:  { fontSize: 24, fontFamily: FONTS.bold, fontWeight: '700', color: TEXT, letterSpacing: -0.5 },
  syncingHint: { fontSize: 12, color: MUTED, fontFamily: FONTS.medium, fontWeight: '500' },
  settingsBtn:  { width: 36, height: 36, borderRadius: 12, backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, alignItems: 'center', justifyContent: 'center' },
  settingsIcon: { fontSize: 17, color: MUTED },

  list:        { flex: 1 },
  listContent: { padding: 16, paddingTop: 4, paddingBottom: 40 },

  sectionLabel: { fontSize: 11, fontFamily: FONTS.semibold, fontWeight: '600', color: MUTED, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },

  errorBanner:      { backgroundColor: '#ef444415', borderWidth: 1, borderColor: '#ef444433', borderRadius: 14, padding: 12, marginBottom: 16 },
  errorBannerTitle: { fontSize: 13, fontFamily: FONTS.semibold, fontWeight: '600', color: RED, marginBottom: 4 },
  errorBannerText:  { fontSize: 12, color: MUTED },

  item:     { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: SURFACE, borderRadius: 14, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: BORDER },
  itemIcon: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  itemIconText: { fontSize: 17 },
  itemBody: { flex: 1, minWidth: 0 },
  itemTitle: { fontSize: 15, color: TEXT, fontWeight: '400' },
  itemSub:   { fontSize: 12, color: MUTED, marginTop: 2 },
  badge:     { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 },
  badgeText: { fontSize: 11, fontFamily: FONTS.semibold, fontWeight: '600' },

  tripCard:  { backgroundColor: SURFACE, borderRadius: 14, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: BORDER },
  tripHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  tripItems: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: BORDER, gap: 0 },
  chevron:   { fontSize: 18, color: MUTED, flexShrink: 0 },

  emptyState:  { alignItems: 'center', paddingTop: 80, paddingHorizontal: 32 },
  emptyIcon:   { fontSize: 48, marginBottom: 16 },
  emptyTitle:  { fontSize: 18, fontFamily: FONTS.semibold, fontWeight: '600', color: TEXT, marginBottom: 8 },
  emptySub:    { fontSize: 14, color: MUTED, textAlign: 'center', lineHeight: 20 },
  connectBtn:  { marginTop: 20, backgroundColor: PURPLE, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 24 },
  connectBtnText: { fontSize: 14, fontFamily: FONTS.semibold, fontWeight: '600', color: '#fff' },
});
