import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveAmbiguousDateTime } from './index';

const env = { CLAUDE_API_KEY: 'test-key' } as any;

function claudeResponse(text: string) {
  return { ok: true, json: async () => ({ content: [{ text }] }) };
}

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveAmbiguousDateTime', () => {
  it('returns the resolved ISO datetime on a successful response', async () => {
    (global.fetch as any).mockResolvedValue(claudeResponse('{"datetime":"2026-08-01T18:00:00"}'));

    const result = await resolveAmbiguousDateTime(
      { message: "let's meet before I leave for the airport Tuesday at 6pm" } as any,
      'Meet before the airport',
      env,
    );

    expect(result).toBe('2026-08-01T18:00:00');
  });

  it('returns explicit null when the model genuinely cannot infer a date', async () => {
    (global.fetch as any).mockResolvedValue(claudeResponse('{"datetime":null}'));

    const result = await resolveAmbiguousDateTime(
      { message: 'we should catch up sometime' } as any,
      'Catch up',
      env,
    );

    expect(result).toBeNull();
  });

  it('strips markdown code fences before parsing', async () => {
    (global.fetch as any).mockResolvedValue(claudeResponse('```json\n{"datetime":"2026-08-01T18:00:00"}\n```'));

    const result = await resolveAmbiguousDateTime({ message: 'x' } as any, 'Task', env);

    expect(result).toBe('2026-08-01T18:00:00');
  });

  it('returns undefined (not null) when the API call fails, so the caller keeps the original guess', async () => {
    (global.fetch as any).mockResolvedValue({ ok: false });

    const result = await resolveAmbiguousDateTime({ message: 'x' } as any, 'Task', env);

    expect(result).toBeUndefined();
  });

  it('returns undefined on malformed JSON instead of throwing', async () => {
    (global.fetch as any).mockResolvedValue(claudeResponse('not json at all'));

    const result = await resolveAmbiguousDateTime({ message: 'x' } as any, 'Task', env);

    expect(result).toBeUndefined();
  });

  it('returns undefined when the datetime field is missing or the wrong type', async () => {
    (global.fetch as any).mockResolvedValue(claudeResponse('{"somethingElse":true}'));
    expect(await resolveAmbiguousDateTime({ message: 'x' } as any, 'Task', env)).toBeUndefined();

    (global.fetch as any).mockResolvedValue(claudeResponse('{"datetime":123}'));
    expect(await resolveAmbiguousDateTime({ message: 'x' } as any, 'Task', env)).toBeUndefined();
  });

  it('sends the full conversation thread when present, not just the latest message', async () => {
    (global.fetch as any).mockResolvedValue(claudeResponse('{"datetime":null}'));

    await resolveAmbiguousDateTime(
      {
        message: 'ignored',
        conversationThread: [
          { sender: 'Maya', text: "let's leave around 6pm" },
          { sender: null, text: 'sounds good' },
        ],
      } as any,
      'Leave for the airport',
      env,
    );

    const sentBody = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    const prompt = sentBody.messages[0].content as string;
    expect(prompt).toContain('<conversation>');
    expect(prompt).toContain("let's leave around 6pm");
  });
});
