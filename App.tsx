import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { suggestReply } from './src/services/claude';
import { getAvailabilityData } from './src/services/googleCalendar';
import { getEtaData } from './src/services/googleMaps';
import type { Intent, SuggestReplyInput } from './src/types';
import { detectIntent } from './src/utils/intentDetector';

const INTENT_LABEL: Record<Intent, string> = {
  eta: '📍 ETA request',
  availability: '📅 Availability request',
  other: '💬 General message',
};

export default function App() {
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [intent, setIntent] = useState<Intent | null>(null);
  const [contextSummary, setContextSummary] = useState('');
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const handleSuggest = async () => {
    if (!message.trim()) return;

    setLoading(true);
    setReply('');
    setContextSummary('');
    setCopied(false);

    try {
      const detected = detectIntent(message);
      setIntent(detected);

      const input: SuggestReplyInput = { originalMessage: message, intent: detected };

      if (detected === 'eta') {
        setStatusText('Fetching journey time…');
        const etaData = await getEtaData();
        input.etaData = etaData;
        setContextSummary(`${etaData.duration} away · ${etaData.distance} via ${etaData.routeSummary}`);
      } else if (detected === 'availability') {
        setStatusText('Checking your calendar…');
        const availabilityData = await getAvailabilityData();
        input.availabilityData = availabilityData;
        setContextSummary(
          availabilityData.events.length === 0
            ? 'No events in the next 7 days'
            : `${availabilityData.events.length} event${availabilityData.events.length !== 1 ? 's' : ''} in the next 7 days`
        );
      }

      setStatusText('Drafting reply with Claude…');
      const suggested = await suggestReply(input);
      setReply(suggested);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      Alert.alert('Error', msg);
    } finally {
      setLoading(false);
      setStatusText('');
    }
  };

  const handleCopy = async () => {
    await Clipboard.setStringAsync(reply);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  const canSubmit = message.trim().length > 0 && !loading;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>ContextReply</Text>
            <Text style={styles.subtitle}>Smart replies grounded in reality</Text>
          </View>

          {/* Input */}
          <Text style={styles.label}>Incoming message</Text>
          <TextInput
            style={styles.input}
            multiline
            placeholder={'e.g. "What\'s your ETA?" or "Are you free Thursday?"'}
            placeholderTextColor="#555"
            value={message}
            onChangeText={setMessage}
            editable={!loading}
            maxLength={1000}
          />

          {/* Button */}
          <Pressable
            style={[styles.button, !canSubmit && styles.buttonDisabled]}
            onPress={handleSuggest}
            disabled={!canSubmit}
          >
            {loading ? (
              <View style={styles.row}>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={[styles.buttonText, { marginLeft: 10 }]}>
                  {statusText || 'Working…'}
                </Text>
              </View>
            ) : (
              <Text style={styles.buttonText}>Suggest Reply</Text>
            )}
          </Pressable>

          {/* Result */}
          {(intent || reply) && !loading ? (
            <View style={styles.card}>
              {intent ? (
                <View style={styles.intentBadge}>
                  <Text style={styles.intentText}>{INTENT_LABEL[intent]}</Text>
                </View>
              ) : null}

              {contextSummary ? (
                <Text style={styles.contextText}>{contextSummary}</Text>
              ) : null}

              {reply ? (
                <>
                  <View style={styles.divider} />
                  <Text style={styles.replyLabel}>SUGGESTED REPLY</Text>
                  <Text style={styles.replyText}>{reply}</Text>
                  <Pressable style={styles.copyBtn} onPress={handleCopy}>
                    <Text style={styles.copyBtnText}>
                      {copied ? '✓  Copied!' : 'Copy to clipboard'}
                    </Text>
                  </Pressable>
                </>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const PURPLE = '#6366f1';
const BG = '#0c0c0e';
const SURFACE = '#18181b';
const BORDER = '#27272a';
const TEXT = '#f4f4f5';
const MUTED = '#71717a';

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  flex: { flex: 1 },
  scroll: { padding: 24, paddingTop: 16 },

  header: { marginBottom: 32 },
  title: { fontSize: 26, fontWeight: '700', color: TEXT, letterSpacing: -0.5 },
  subtitle: { fontSize: 14, color: MUTED, marginTop: 4 },

  label: {
    fontSize: 12,
    fontWeight: '600',
    color: MUTED,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  input: {
    backgroundColor: SURFACE,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: BORDER,
    padding: 16,
    fontSize: 16,
    color: TEXT,
    minHeight: 110,
    textAlignVertical: 'top',
    marginBottom: 16,
  },

  button: {
    backgroundColor: PURPLE,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 24,
  },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  row: { flexDirection: 'row', alignItems: 'center' },

  card: {
    backgroundColor: SURFACE,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: BORDER,
    padding: 20,
  },
  intentBadge: {
    backgroundColor: '#1e1b4b',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 5,
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  intentText: { color: '#a5b4fc', fontSize: 13, fontWeight: '500' },
  contextText: { color: MUTED, fontSize: 13, marginBottom: 4 },

  divider: { height: 1, backgroundColor: BORDER, marginVertical: 16 },

  replyLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: PURPLE,
    letterSpacing: 1.2,
    marginBottom: 10,
  },
  replyText: { color: TEXT, fontSize: 16, lineHeight: 26, marginBottom: 18 },

  copyBtn: {
    backgroundColor: BORDER,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignSelf: 'flex-start',
  },
  copyBtnText: { color: '#a1a1aa', fontSize: 14, fontWeight: '500' },
});
