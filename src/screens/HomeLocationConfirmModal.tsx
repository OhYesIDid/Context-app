import React from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { PURPLE, SURFACE, SURFACE2, BORDER, TEXT, MUTED, FONTS, CONTEXT } from '../theme';

const MAPS_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;

export interface HomeCandidate {
  lat: number;
  lon: number;
  area?: string;
}

interface Props {
  candidate: HomeCandidate | null;
  onConfirm: (candidate: HomeCandidate) => void;
  onDismiss: () => void;
}

function staticMapUrl(lat: number, lon: number): string | null {
  if (!MAPS_API_KEY) return null;
  const params = new URLSearchParams({
    center: `${lat},${lon}`,
    zoom: '15',
    size: '600x280',
    scale: '2',
    markers: `color:0xe2933c|${lat},${lon}`,
    key: MAPS_API_KEY,
  });
  return `https://maps.googleapis.com/maps/api/staticmap?${params}`;
}

export default function HomeLocationConfirmModal({ candidate, onConfirm, onDismiss }: Props) {
  const mapUrl = candidate ? staticMapUrl(candidate.lat, candidate.lon) : null;

  return (
    <Modal visible={!!candidate} transparent animationType="slide" onRequestClose={onDismiss}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.titleRow}>
            <View style={styles.titleIcon}>
              <Text style={styles.titleIconText}>📍</Text>
            </View>
            <Text style={styles.title}>Is this your home?</Text>
          </View>
          <Text style={styles.subtitle}>
            We noticed you've spent the night near here a few times. Check the map before saving —
            this helps give better ETA and availability replies.
          </Text>

          <View style={styles.mapBox}>
            {mapUrl ? (
              <Image source={{ uri: mapUrl }} style={styles.map} resizeMode="cover" />
            ) : (
              <View style={styles.mapFallback}>
                <Text style={styles.mapFallbackText}>📍</Text>
              </View>
            )}
          </View>

          <View style={styles.addressRow}>
            <View style={styles.addressDot} />
            {candidate?.area ? (
              <Text style={styles.address} numberOfLines={2}>{candidate.area}</Text>
            ) : (
              <Text style={styles.addressMuted}>Address unavailable — location shown above</Text>
            )}
          </View>

          <Pressable
            style={styles.confirmBtn}
            onPress={() => candidate && onConfirm(candidate)}
          >
            <Text style={styles.confirmBtnText}>Yes, save as Home</Text>
          </Pressable>
          <Pressable style={styles.dismissBtn} onPress={onDismiss}>
            <Text style={styles.dismissBtnText}>Not my home</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: '#000000bb', justifyContent: 'flex-end' },
  sheet:   { backgroundColor: SURFACE, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: BORDER, borderBottomWidth: 0, padding: 20, paddingBottom: 32 },
  handle:  { width: 36, height: 4, backgroundColor: BORDER, borderRadius: 2, alignSelf: 'center', marginBottom: 16 },

  titleRow:  { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  titleIcon: { width: 30, height: 30, borderRadius: 9, backgroundColor: CONTEXT + '20', alignItems: 'center', justifyContent: 'center' },
  titleIconText: { fontSize: 14 },
  title:    { fontSize: 19, fontFamily: FONTS.bold, fontWeight: '700', color: TEXT, letterSpacing: -0.3 },
  subtitle: { fontSize: 13, color: MUTED, lineHeight: 19, marginBottom: 16 },

  mapBox:  { borderRadius: 16, overflow: 'hidden', backgroundColor: SURFACE2, borderWidth: 1, borderColor: BORDER, marginBottom: 12 },
  map:     { width: '100%', height: 160 },
  mapFallback:     { width: '100%', height: 160, alignItems: 'center', justifyContent: 'center' },
  mapFallbackText: { fontSize: 40 },

  addressRow:   { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: SURFACE2, borderRadius: 12, borderWidth: 1, borderColor: BORDER, padding: 12, marginBottom: 20 },
  addressDot:   { width: 8, height: 8, borderRadius: 4, backgroundColor: CONTEXT, marginTop: 5, flexShrink: 0 },
  address:      { flex: 1, fontSize: 14, color: TEXT, lineHeight: 20 },
  addressMuted: { flex: 1, fontSize: 13, color: MUTED, fontStyle: 'italic' },

  confirmBtn:     { backgroundColor: PURPLE, borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginBottom: 10 },
  confirmBtnText: { fontSize: 15, fontFamily: FONTS.semibold, fontWeight: '600', color: '#fff' },
  dismissBtn:     { paddingVertical: 12, alignItems: 'center' },
  dismissBtnText: { fontSize: 14, fontFamily: FONTS.medium, fontWeight: '500', color: MUTED },
});
