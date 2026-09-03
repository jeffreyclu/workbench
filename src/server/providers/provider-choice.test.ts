import { afterEach, describe, expect, it } from 'vitest';
import { aiProviderAvailability, palmyraAvailability, resolveAiProvider } from './provider-choice.js';

const originalKey = process.env.WRITER_API_KEY;
afterEach(() => {
  if (originalKey === undefined) delete process.env.WRITER_API_KEY;
  else process.env.WRITER_API_KEY = originalKey;
});

describe('palmyraAvailability', () => {
  it('reports Palmyra unavailable with a reason when no Writer key is configured', () => {
    delete process.env.WRITER_API_KEY;
    const availability = palmyraAvailability('default');
    expect(availability.available).toBe(false);
    expect(availability.reason).toMatch(/no writer api key/i);
  });

  it('serves the personal profile from the one work key and says so', () => {
    process.env.WRITER_API_KEY = 'writer-work-key';
    const availability = palmyraAvailability('personal');
    expect(availability.available).toBe(true);
    expect(availability.reason).toMatch(/no personal writer key/i);
    expect(palmyraAvailability('default')).toEqual({ available: true, reason: null, model: expect.any(String) });
  });
});

describe('resolveAiProvider', () => {
  it('keeps auto on Claude until a usable Writer key exists', () => {
    delete process.env.WRITER_API_KEY;
    expect(resolveAiProvider('auto')).toBe('claude');
    expect(resolveAiProvider(null)).toBe('claude');
    process.env.WRITER_API_KEY = 'writer-work-key';
    expect(resolveAiProvider('auto')).toBe('palmyra');
  });

  it('honors an explicit Claude choice even where Palmyra is reachable', () => {
    process.env.WRITER_API_KEY = 'writer-work-key';
    expect(resolveAiProvider('claude', 'default')).toBe('claude');
  });

  it('runs Palmyra on the personal profile, the profile Workbench itself uses', () => {
    process.env.WRITER_API_KEY = 'writer-work-key';
    expect(resolveAiProvider('palmyra', 'personal')).toBe('palmyra');
    expect(resolveAiProvider('auto', 'personal')).toBe('palmyra');
    delete process.env.WRITER_API_KEY;
    expect(resolveAiProvider('palmyra', 'personal')).toBe('claude');
  });

  it('reports the profile, the resolved provider, and the Palmyra reason together', () => {
    process.env.WRITER_API_KEY = 'writer-work-key';
    expect(aiProviderAvailability('palmyra', 'personal')).toEqual({
      accountProfile: 'personal',
      resolved: 'palmyra',
      palmyra: { available: true, reason: expect.stringMatching(/work key/i), model: expect.any(String) },
    });
  });
});
