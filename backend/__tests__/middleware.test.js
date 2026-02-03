/**
 * Tests for shared middleware
 */

const { healthCheck } = require('../shared/middleware');

describe('healthCheck', () => {
  test('returns a function', () => {
    const handler = healthCheck('test-service');
    expect(typeof handler).toBe('function');
  });

  test('returns status ok', () => {
    const handler = healthCheck('test-service');
    const mockRes = {
      json: jest.fn(),
    };

    handler({}, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        service: 'test-service',
      })
    );
  });

  test('includes timestamp', () => {
    const handler = healthCheck('test-service');
    const mockRes = {
      json: jest.fn(),
    };

    handler({}, mockRes);

    const response = mockRes.json.mock.calls[0][0];
    expect(response.timestamp).toBeDefined();
    expect(new Date(response.timestamp)).toBeInstanceOf(Date);
  });

  test('includes memory info', () => {
    const handler = healthCheck('test-service');
    const mockRes = {
      json: jest.fn(),
    };

    handler({}, mockRes);

    const response = mockRes.json.mock.calls[0][0];
    expect(response.memory).toBeDefined();
    expect(response.memory.heapUsed).toMatch(/\d+MB/);
    expect(response.memory.heapTotal).toMatch(/\d+MB/);
    expect(response.memory.heapPercent).toMatch(/\d+%/);
  });

  test('includes uptime', () => {
    const handler = healthCheck('test-service');
    const mockRes = {
      json: jest.fn(),
    };

    handler({}, mockRes);

    const response = mockRes.json.mock.calls[0][0];
    expect(response.uptime).toMatch(/\d+s/);
  });

  test('uses correct service name', () => {
    const handler = healthCheck('my-custom-service');
    const mockRes = {
      json: jest.fn(),
    };

    handler({}, mockRes);

    const response = mockRes.json.mock.calls[0][0];
    expect(response.service).toBe('my-custom-service');
  });
});
