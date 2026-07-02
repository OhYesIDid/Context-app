import { close } from 'expo-share-extension';
import { Text, TextInput } from 'expo-share-extension';
import type { InitialProps } from 'expo-share-extension';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { suggestReply } from './src/services/claude';
import { detectIntent } from './src/utils/intentDetector';

const PURPLE = '#6366f1';
const BG = '#0c0c0e';
const SURFACE = '#18181b';
const BORDER = '#27272a';
const TEXT_COLOR = '#f4f4f5';
const MUTED = '#71717a';

export default function ShareExtension({ text, url }: InitialProps) {
  const incoming = (text ?? url ?? '').trim();
  const [reply, setReply] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!incoming) return;
    (async () => {
      setLoading(true);
      try {
        const intent = detectIntent(incoming);
        const result = await suggestReply({ originalMessage: incoming, intent });
        setReply(result.casual);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Something went wrong');
      } finally {
        setLoading(false);
      }
    })();
  }, [incoming]);

  return (
    <View style={styles.container}>
      <View style={styles.handle} />

      <Text style={styles.label} allowFontScaling={false}>INCOMING MESSAGE</Text>
      <Text style={styles.incoming} allowFontScaling={false} numberOfLines={4}>
        {incoming || 'No text received'}
      </Text>

      <View style={styles.divider} />

      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={PURPLE} size="small" />
          <Text style={styles.loadingText} allowFontScaling={false}>Drafting reply…</Text>
        </View>
      ) : error ? (
        <Text style={styles.errorText} allowFontScaling={false}>{error}</Text>
      ) : reply ? (
        <>
          <Text style={styles.label} allowFontScaling={false}>SUGGESTED REPLY</Text>
          <TextInput
            style={styles.replyInput}
            value={reply}
            onChangeText={setReply}
            multiline
            allowFontScaling={false}
          />
        </>
      ) : null}

      <View style={styles.buttonRow}>
        <Pressable style={styles.closeBtn} onPress={close}>
          <Text style={styles.closeBtnText} allowFontScaling={false}>Cancel</Text>
        </Pressable>
        {reply ? (
          <Pressable
            style={styles.copyBtn}
            onPress={async () => {
              const { setStringAsync } = await import('expo-clipboard');
              await setStringAsync(reply);
              close();
            }}
          >
            <Text style={styles.copyBtnText} allowFontScaling={false}>Copy & Close</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BG,
    padding: 20,
    paddingTop: 12,
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: BORDER,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 16,
  },
  label: {
    fontSize: 10,
    fontWeight: '700',
    color: PURPLE,
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  incoming: {
    color: MUTED,
    fontSize: 15,
    lineHeight: 22,
  },
  divider: {
    height: 1,
    backgroundColor: BORDER,
    marginVertical: 16,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  loadingText: {
    color: MUTED,
    fontSize: 14,
  },
  errorText: {
    color: '#f87171',
    fontSize: 14,
  },
  replyInput: {
    backgroundColor: SURFACE,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: BORDER,
    padding: 14,
    fontSize: 15,
    color: TEXT_COLOR,
    lineHeight: 22,
    minHeight: 90,
    textAlignVertical: 'top',
    marginBottom: 16,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 'auto',
  },
  closeBtn: {
    flex: 1,
    backgroundColor: SURFACE,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: BORDER,
    paddingVertical: 14,
    alignItems: 'center',
  },
  closeBtnText: {
    color: MUTED,
    fontSize: 15,
    fontWeight: '500',
  },
  copyBtn: {
    flex: 2,
    backgroundColor: PURPLE,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  copyBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
