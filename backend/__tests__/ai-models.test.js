/**
 * Tests for shared/ai-models.js
 */

const {
  MODEL_CONFIG,
  TEMPERATURE_PRESETS,
  withRetry,
  safeAPICall,
  callWithFallback,
  withTimeout,
  calculateModelCost,
  createCostTracker,
  extractJSON,
  ensureString,
} = require('../shared/ai-models');

describe('ai-models', () => {
  describe('MODEL_CONFIG', () => {
    it('has configuration for gpt-4.1', () => {
      expect(MODEL_CONFIG['gpt-4.1']).toBeDefined();
      expect(MODEL_CONFIG['gpt-4.1'].provider).toBe('openai');
      expect(MODEL_CONFIG['gpt-4.1'].cost.input).toBeGreaterThan(0);
      expect(MODEL_CONFIG['gpt-4.1'].cost.output).toBeGreaterThan(0);
    });

    it('has configuration for gemini-2.5-flash', () => {
      expect(MODEL_CONFIG['gemini-2.5-flash']).toBeDefined();
      expect(MODEL_CONFIG['gemini-2.5-flash'].provider).toBe('gemini');
    });

    it('has configuration for deepseek models', () => {
      expect(MODEL_CONFIG['deepseek-chat']).toBeDefined();
      expect(MODEL_CONFIG['deepseek-reasoner']).toBeDefined();
    });

    it('has configuration for perplexity', () => {
      expect(MODEL_CONFIG['sonar-pro']).toBeDefined();
      expect(MODEL_CONFIG['sonar-pro'].timeout).toBe(90000);
    });
  });

  describe('TEMPERATURE_PRESETS', () => {
    it('has deterministic preset at 0', () => {
      expect(TEMPERATURE_PRESETS.deterministic).toBe(0.0);
    });

    it('has conservative preset', () => {
      expect(TEMPERATURE_PRESETS.conservative).toBe(0.1);
    });

    it('has balanced preset', () => {
      expect(TEMPERATURE_PRESETS.balanced).toBe(0.3);
    });

    it('has creative preset', () => {
      expect(TEMPERATURE_PRESETS.creative).toBe(0.7);
    });
  });

  describe('withRetry', () => {
    it('returns result on first success', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const result = await withRetry(fn, 3, 10, 'test');
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on failure and succeeds', async () => {
      const fn = jest.fn().mockRejectedValueOnce(new Error('fail1')).mockResolvedValue('success');
      const result = await withRetry(fn, 3, 10, 'test');
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('returns null after max retries', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('always fail'));
      const result = await withRetry(fn, 2, 10, 'test');
      expect(result).toBeNull();
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('does not retry on 4xx errors except 429', async () => {
      const error = new Error('bad request');
      error.status = 400;
      const fn = jest.fn().mockRejectedValue(error);
      const result = await withRetry(fn, 3, 10, 'test');
      expect(result).toBeNull();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on 429 rate limit', async () => {
      const error = new Error('rate limit');
      error.status = 429;
      const fn = jest.fn().mockRejectedValueOnce(error).mockResolvedValue('success');
      const result = await withRetry(fn, 3, 10, 'test');
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('safeAPICall', () => {
    it('returns result on success', async () => {
      const fn = jest.fn().mockResolvedValue('data');
      const result = await safeAPICall(fn, 'test');
      expect(result).toBe('data');
    });

    it('returns fallback on error', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const result = await safeAPICall(fn, 'test', 'fallback');
      expect(result).toBe('fallback');
    });

    it('uses empty string as default fallback', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const result = await safeAPICall(fn, 'test');
      expect(result).toBe('');
    });
  });

  describe('callWithFallback', () => {
    it('uses primary when successful', async () => {
      const primary = jest.fn().mockResolvedValue('primary result');
      const fallback = jest.fn().mockResolvedValue('fallback result');
      const result = await callWithFallback(primary, fallback, 'Primary', 'Fallback');
      expect(result.result).toBe('primary result');
      expect(result.usedFallback).toBe(false);
      expect(result.model).toBe('Primary');
      expect(fallback).not.toHaveBeenCalled();
    });

    it('uses fallback when primary fails', async () => {
      const primary = jest.fn().mockRejectedValue(new Error('primary fail'));
      const fallback = jest.fn().mockResolvedValue('fallback result');
      const result = await callWithFallback(primary, fallback, 'Primary', 'Fallback');
      expect(result.result).toBe('fallback result');
      expect(result.usedFallback).toBe(true);
      expect(result.model).toBe('Fallback');
    });

    it('uses fallback when primary returns empty', async () => {
      const primary = jest.fn().mockResolvedValue('');
      const fallback = jest.fn().mockResolvedValue('fallback result');
      const result = await callWithFallback(primary, fallback, 'Primary', 'Fallback');
      expect(result.result).toBe('fallback result');
      expect(result.usedFallback).toBe(true);
    });

    it('returns null when both fail', async () => {
      const primary = jest.fn().mockRejectedValue(new Error('fail'));
      const fallback = jest.fn().mockRejectedValue(new Error('fail'));
      const result = await callWithFallback(primary, fallback, 'Primary', 'Fallback');
      expect(result.result).toBeNull();
      expect(result.usedFallback).toBe(true);
    });
  });

  describe('withTimeout', () => {
    it('returns result before timeout', async () => {
      const promise = Promise.resolve('quick');
      const result = await withTimeout(promise, 1000, 'test');
      expect(result).toBe('quick');
    });

    it('rejects on timeout', async () => {
      const slowPromise = new Promise((resolve) => setTimeout(() => resolve('slow'), 100));
      await expect(withTimeout(slowPromise, 10, 'test')).rejects.toThrow(
        'test timed out after 10ms'
      );
    });
  });

  describe('calculateModelCost', () => {
    it('calculates gpt-4.1 cost correctly', () => {
      const { cost, breakdown } = calculateModelCost('gpt-4.1', 1000000, 500000);
      expect(breakdown.input).toBe(2.0); // 1M * $2.0/1M
      expect(breakdown.output).toBe(4.0); // 0.5M * $8.0/1M
      expect(cost).toBe(6.0);
    });

    it('calculates gemini cost correctly', () => {
      const { cost } = calculateModelCost('gemini-2.5-flash', 1000000, 1000000);
      expect(cost).toBe(0.5); // 0.1 + 0.4
    });

    it('returns zero for unknown model', () => {
      const { cost } = calculateModelCost('unknown-model', 1000, 1000);
      expect(cost).toBe(0);
    });

    it('handles zero tokens', () => {
      const { cost } = calculateModelCost('gpt-4.1', 0, 0);
      expect(cost).toBe(0);
    });
  });

  describe('createCostTracker', () => {
    it('tracks costs across multiple calls', () => {
      const tracker = createCostTracker();
      tracker.add('gpt-4.1', 1000, 1000, 'search');
      tracker.add('gemini-2.5-flash', 1000, 1000, 'validation');
      const summary = tracker.getSummary();
      expect(summary.callCount).toBe(2);
      expect(summary.totalCost).toBeGreaterThan(0);
    });

    it('groups by model and feature', () => {
      const tracker = createCostTracker();
      tracker.add('gpt-4.1', 1000, 500, 'search');
      tracker.add('gpt-4.1', 2000, 1000, 'search');
      tracker.add('gemini-2.5-flash', 1000, 500, 'validation');
      const summary = tracker.getSummary();
      expect(Object.keys(summary.byModel)).toContain('gpt-4.1');
      expect(Object.keys(summary.byModel)).toContain('gemini-2.5-flash');
      expect(Object.keys(summary.byFeature)).toContain('search');
      expect(Object.keys(summary.byFeature)).toContain('validation');
    });

    it('returns total cost correctly', () => {
      const tracker = createCostTracker();
      const cost1 = tracker.add('gpt-4.1', 1000000, 0);
      const cost2 = tracker.add('gpt-4.1', 0, 1000000);
      expect(tracker.getTotalCost()).toBe(cost1 + cost2);
    });
  });

  describe('extractJSON', () => {
    it('parses valid JSON directly', () => {
      const result = extractJSON('{"key": "value"}');
      expect(result).toEqual({ key: 'value' });
    });

    it('parses JSON array', () => {
      const result = extractJSON('[1, 2, 3]');
      expect(result).toEqual([1, 2, 3]);
    });

    it('extracts JSON from markdown code block', () => {
      const text = 'Here is the result:\n```json\n{"name": "test"}\n```';
      const result = extractJSON(text);
      expect(result).toEqual({ name: 'test' });
    });

    it('extracts JSON from plain code block', () => {
      const text = '```\n{"name": "test"}\n```';
      const result = extractJSON(text);
      expect(result).toEqual({ name: 'test' });
    });

    it('finds embedded JSON array in text', () => {
      const text = 'The companies are: [{"name": "Acme"}] as listed.';
      const result = extractJSON(text);
      expect(result).toEqual([{ name: 'Acme' }]);
    });

    it('finds embedded JSON object in text', () => {
      const text = 'Result: {"status": "ok"} end';
      const result = extractJSON(text);
      expect(result).toEqual({ status: 'ok' });
    });

    it('returns null for invalid JSON', () => {
      const result = extractJSON('not json at all');
      expect(result).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(extractJSON('')).toBeNull();
      expect(extractJSON(null)).toBeNull();
      expect(extractJSON(undefined)).toBeNull();
    });
  });

  describe('ensureString', () => {
    it('returns string as-is', () => {
      expect(ensureString('hello')).toBe('hello');
    });

    it('returns default for null/undefined', () => {
      expect(ensureString(null)).toBe('');
      expect(ensureString(undefined)).toBe('');
      expect(ensureString(null, 'default')).toBe('default');
    });

    it('joins arrays', () => {
      expect(ensureString(['a', 'b', 'c'])).toBe('a, b, c');
    });

    it('handles nested arrays', () => {
      expect(ensureString([['a', 'b'], 'c'])).toBe('a, b, c');
    });

    it('extracts text from object with text property', () => {
      expect(ensureString({ text: 'hello' })).toBe('hello');
    });

    it('extracts value from object with value property', () => {
      expect(ensureString({ value: 'hello' })).toBe('hello');
    });

    it('extracts name from object with name property', () => {
      expect(ensureString({ name: 'hello' })).toBe('hello');
    });

    it('formats city, country objects', () => {
      expect(ensureString({ city: 'Tokyo', country: 'Japan' })).toBe('Tokyo, Japan');
    });

    it('stringifies other objects', () => {
      expect(ensureString({ a: 1 })).toBe('{"a":1}');
    });

    it('converts numbers to string', () => {
      expect(ensureString(123)).toBe('123');
    });

    it('converts boolean to string', () => {
      expect(ensureString(true)).toBe('true');
    });
  });
});
