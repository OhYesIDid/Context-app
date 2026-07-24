import { describe, it, expect } from 'vitest';
import { parseReplies } from './index';

function claudeJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe('parseReplies', () => {
  it('parses the base reply tones with no optional fields', () => {
    const result = parseReplies(claudeJson({ formal: 'Sure.', casual: 'Yep!', brief: 'Yes.' }));
    expect(result.formal).toBe('Sure.');
    expect(result.casual).toBe('Yep!');
    expect(result.brief).toBe('Yes.');
    expect(result.extractedMemories).toBeUndefined();
  });

  it('parses a valid commitment with an explicit expiresAt', () => {
    const result = parseReplies(claudeJson({
      formal: 'Sure.', casual: 'Yep!', brief: 'Yes.',
      extractedMemories: [{ type: 'commitment', text: "Send Maya the venue address", expiresAt: '2026-08-01' }],
    }));
    expect(result.extractedMemories).toEqual([
      { type: 'commitment', text: "Send Maya the venue address", expiresAt: '2026-08-01' },
    ]);
  });

  it('parses a valid preference and always drops any expiresAt for it', () => {
    const result = parseReplies(claudeJson({
      formal: 'Sure.', casual: 'Yep!', brief: 'Yes.',
      extractedMemories: [{ type: 'preference', text: 'Allergic to shellfish', expiresAt: '2026-08-01' }],
    }));
    expect(result.extractedMemories).toEqual([
      { type: 'preference', text: 'Allergic to shellfish', expiresAt: undefined },
    ]);
  });

  it('drops entries with an invalid type', () => {
    const result = parseReplies(claudeJson({
      formal: 'Sure.', casual: 'Yep!', brief: 'Yes.',
      extractedMemories: [{ type: 'topic', text: 'Discussed the new job' }],
    }));
    expect(result.extractedMemories).toBeUndefined();
  });

  it('drops entries with empty or missing text', () => {
    const result = parseReplies(claudeJson({
      formal: 'Sure.', casual: 'Yep!', brief: 'Yes.',
      extractedMemories: [{ type: 'commitment', text: '   ' }, { type: 'preference' }],
    }));
    expect(result.extractedMemories).toBeUndefined();
  });

  it('caps extractedMemories at 2 entries even if the model returns more', () => {
    const result = parseReplies(claudeJson({
      formal: 'Sure.', casual: 'Yep!', brief: 'Yes.',
      extractedMemories: [
        { type: 'preference', text: 'One' },
        { type: 'preference', text: 'Two' },
        { type: 'preference', text: 'Three' },
      ],
    }));
    expect(result.extractedMemories).toHaveLength(2);
  });

  it('trims whitespace from extracted memory text', () => {
    const result = parseReplies(claudeJson({
      formal: 'Sure.', casual: 'Yep!', brief: 'Yes.',
      extractedMemories: [{ type: 'commitment', text: '  Call back tomorrow  ' }],
    }));
    expect(result.extractedMemories?.[0].text).toBe('Call back tomorrow');
  });

  it('ignores extractedMemories entirely when the field is not an array', () => {
    const result = parseReplies(claudeJson({
      formal: 'Sure.', casual: 'Yep!', brief: 'Yes.',
      extractedMemories: 'not an array',
    }));
    expect(result.extractedMemories).toBeUndefined();
  });

  it('falls back to raw text for unparseable JSON, without throwing on extractedMemories', () => {
    const result = parseReplies('not json at all');
    expect(result.formal).toBe('not json at all');
    expect(result.extractedMemories).toBeUndefined();
  });
});
