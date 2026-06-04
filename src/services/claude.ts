import type { SuggestReplyInput } from '../types';
import { formatAvailability } from './googleCalendar';

const API_KEY = process.env.EXPO_PUBLIC_CLAUDE_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = `You draft short, natural replies to messages on behalf of the user. Rules:
- Sound like a real person texting — casual, warm, direct
- 1–3 sentences maximum, no filler
- If given real data (journey time, calendar), weave it in naturally
- Never say "I" as if you are the assistant; speak as the user`;

export async function suggestReply(input: SuggestReplyInput): Promise<string> {
  if (!API_KEY) {
    throw new Error(
      'Claude API key missing. Add EXPO_PUBLIC_CLAUDE_API_KEY to your .env file.'
    );
  }

  let contextBlock = '';

  if (input.intent === 'eta' && input.etaData) {
    const { duration, distance, routeSummary } = input.etaData;
    contextBlock = `Real-time travel data: currently ${duration} away (${distance}) via ${routeSummary}.`;
  } else if (input.intent === 'availability' && input.availabilityData) {
    contextBlock = formatAvailability(input.availabilityData);
  }

  const userContent = [
    `Incoming message: "${input.originalMessage}"`,
    contextBlock && `\nContext:\n${contextBlock}`,
    '\nWrite a reply for the user.',
  ]
    .filter(Boolean)
    .join('');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      // Required when calling the API from client-side JS (browser / Expo web)
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      `Claude API error ${res.status}: ${(err as any)?.error?.message ?? res.statusText}`
    );
  }

  const data = await res.json();
  const text: string = data.content?.[0]?.text ?? '';
  return text.trim();
}
