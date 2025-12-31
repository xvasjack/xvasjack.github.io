/**
 * Unit tests for common utility functions
 */

// Re-implement testable utilities here (extracted from server code)
// In a real refactor, these would be imported from a shared utils module

function ensureString(value, defaultValue = '') {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return defaultValue;
  if (Array.isArray(value)) return value.map(v => ensureString(v)).join(', ');
  if (typeof value === 'object') {
    if (value.city && value.country) return `${value.city}, ${value.country}`;
    if (value.text) return ensureString(value.text);
    if (value.value) return ensureString(value.value);
    if (value.name) return ensureString(value.name);
    try { return JSON.stringify(value); } catch { return defaultValue; }
  }
  return String(value);
}

function pcmToWav(pcmBuffer, sampleRate = 16000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcmBuffer.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const wavBuffer = Buffer.alloc(fileSize);

  wavBuffer.write('RIFF', 0);
  wavBuffer.writeUInt32LE(fileSize - 8, 4);
  wavBuffer.write('WAVE', 8);
  wavBuffer.write('fmt ', 12);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20);
  wavBuffer.writeUInt16LE(numChannels, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(byteRate, 28);
  wavBuffer.writeUInt16LE(blockAlign, 32);
  wavBuffer.writeUInt16LE(bitsPerSample, 34);
  wavBuffer.write('data', 36);
  wavBuffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(wavBuffer, 44);

  return wavBuffer;
}

describe('ensureString', () => {
  test('returns string as-is', () => {
    expect(ensureString('hello')).toBe('hello');
    expect(ensureString('')).toBe('');
  });

  test('returns default for null/undefined', () => {
    expect(ensureString(null)).toBe('');
    expect(ensureString(undefined)).toBe('');
    expect(ensureString(null, 'default')).toBe('default');
  });

  test('joins arrays with comma', () => {
    expect(ensureString(['a', 'b', 'c'])).toBe('a, b, c');
    expect(ensureString([])).toBe('');
  });

  test('extracts city/country from object', () => {
    expect(ensureString({ city: 'NYC', country: 'USA' })).toBe('NYC, USA');
  });

  test('extracts text/value/name from object', () => {
    expect(ensureString({ text: 'hello' })).toBe('hello');
    expect(ensureString({ value: 'world' })).toBe('world');
    expect(ensureString({ name: 'test' })).toBe('test');
  });

  test('stringifies unknown objects', () => {
    expect(ensureString({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });

  test('converts numbers to string', () => {
    expect(ensureString(123)).toBe('123');
    expect(ensureString(0)).toBe('0');
  });

  test('converts booleans to string', () => {
    expect(ensureString(true)).toBe('true');
    expect(ensureString(false)).toBe('false');
  });
});

describe('pcmToWav', () => {
  test('creates valid WAV header', () => {
    const pcm = Buffer.alloc(100);
    const wav = pcmToWav(pcm);

    expect(wav.length).toBe(144); // 44 header + 100 data
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
  });

  test('writes correct file size', () => {
    const pcm = Buffer.alloc(100);
    const wav = pcmToWav(pcm);

    const fileSize = wav.readUInt32LE(4);
    expect(fileSize).toBe(144 - 8); // total size minus 8
  });

  test('writes correct data size', () => {
    const pcm = Buffer.alloc(100);
    const wav = pcmToWav(pcm);

    const dataSize = wav.readUInt32LE(40);
    expect(dataSize).toBe(100);
  });

  test('preserves PCM data', () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5]);
    const wav = pcmToWav(pcm);

    expect(wav.slice(44)).toEqual(pcm);
  });
});
