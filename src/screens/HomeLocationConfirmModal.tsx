import React from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

const PURPLE  = '#6366f1';
const SURFACE = '#18181b';
const BORDER  = '#27272a';
const TEXT    = '#f4f4f5';
const MUTED   = '#71717a';

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
    markers: `color:0x6366f1|${lat},${lon}`,
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

          <Text style={styles.title}>Is this your home?</Text>
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

          {candidate?.area ? (
            <Text style={styles.address} numberOfLines={2}>{candidate.area}</Text>
          ) : (
            <Text style={styles.addressMuted}>Address unavailable — location shown above</Text>
          )}

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
  sheet:   { backgroundColor: '#1c1c1e', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 32 },
  handle:  { width: 36, height: 4, backgroundColor: BORDER, borderRadius: 2, alignSelf: 'center', marginBottom: 16 },

  title:    { fontSize: 20, fontWeight: '700', color: TEXT, letterSpacing: -0.3, marginBottom: 8 },
  subtitle: { fontSize: 13, color: MUTED, lineHeight: 19, marginBottom: 16 },

  mapBox:  { borderRadius: 16, overflow: 'hidden', backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER, marginBottom: 12 },
  map:     { width: '100%', height: 160 },
  mapFallback:     { width: '100%', height: 160, alignItems: 'center', justifyContent: 'center' },
  mapFallbackText: { fontSize: 40 },

  address:      { fontSize: 14, color: TEXT, marginBottom: 20, lineHeight: 20 },
  addressMuted: { fontSize: 13, color: MUTED, fontStyle: 'italic', marginBottom: 20 },

  confirmBtn:     { backgroundColor: PURPLE, borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginBottom: 10 },
  confirmBtnText: { fontSize: 15, fontWeight: '600', color: '#fff' },
  dismissBtn:     { paddingVertical: 12, alignItems: 'center' },
  dismissBtnText: { fontSize: 14, fontWeight: '500', color: MUTED },
});
