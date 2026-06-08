import { registerRootComponent } from 'expo';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import App from './App';

class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <View style={s.container}>
          <Text style={s.title}>Crash report</Text>
          <ScrollView>
            <Text style={s.body} selectable>
              {this.state.error?.toString?.() ?? 'Unknown error'}
              {'\n\n'}
              {this.state.error?.stack ?? ''}
            </Text>
          </ScrollView>
        </View>
      );
    }
    return React.createElement(App);
  }
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0c0e', padding: 24, paddingTop: 60 },
  title: { color: '#f87171', fontSize: 18, fontWeight: '700', marginBottom: 16 },
  body: { color: '#f4f4f5', fontSize: 12, fontFamily: 'monospace', lineHeight: 18 },
});

registerRootComponent(ErrorBoundary);
