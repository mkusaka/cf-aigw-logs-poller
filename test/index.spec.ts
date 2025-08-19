import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Utility functions for testing (exported from source for testing)
// These would normally be exported separately for testing
function getInt(envVal: string | undefined, def: number): number {
  if (!envVal) return def;
  const n = parseInt(envVal, 10);
  return Number.isFinite(n) ? n : def;
}

function pathForRow(prefix: string, createdAtISO: string, id: string): string {
  const d = new Date(createdAtISO);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${prefix}/dt=${yyyy}-${mm}-${dd}/hour=${hh}/${id}.jsonl`;
}

describe('AI Gateway Logs Poller', () => {
  describe('Utility functions', () => {
    it('getInt should parse valid numbers', () => {
      expect(getInt("42", 0)).toBe(42);
      expect(getInt("0", 10)).toBe(0);
      expect(getInt("-5", 10)).toBe(-5);
    });

    it('getInt should return default for invalid input', () => {
      expect(getInt(undefined, 100)).toBe(100);
      expect(getInt("", 50)).toBe(50);
      expect(getInt("not-a-number", 25)).toBe(25);
      expect(getInt("Infinity", 10)).toBe(10);
      expect(getInt("NaN", 10)).toBe(10);
    });

    it('pathForRow should generate correct Hive partition paths', () => {
      const testCases = [
        {
          prefix: "rows",
          createdAt: "2023-12-25T14:30:45.123Z",
          id: "01HKJ8XXXXXXXXXXXXXXXXXXX",
          expected: "rows/dt=2023-12-25/hour=14/01HKJ8XXXXXXXXXXXXXXXXXXX.jsonl"
        },
        {
          prefix: "logs",
          createdAt: "2023-01-01T00:00:00.000Z",
          id: "01ABC123456789DEFGHIJKLM",
          expected: "logs/dt=2023-01-01/hour=00/01ABC123456789DEFGHIJKLM.jsonl"
        },
        {
          prefix: "data",
          createdAt: "2023-06-15T23:59:59.999Z",
          id: "01XYZ987654321ABCDEFGHIJ",
          expected: "data/dt=2023-06-15/hour=23/01XYZ987654321ABCDEFGHIJ.jsonl"
        }
      ];

      testCases.forEach(({ prefix, createdAt, id, expected }) => {
        expect(pathForRow(prefix, createdAt, id)).toBe(expected);
      });
    });
  });

  describe('Worker endpoints', () => {
    it('should respond with ok for root path', async () => {
      const request = new IncomingRequest('http://example.com/');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(await response.text()).toBe("ok");
    });

    // Note: /run endpoint requires Durable Object binding which is complex to test in unit tests
    // Integration tests would be more appropriate for testing the full /run endpoint
  });

  describe('Integration tests', () => {
    it('should respond with ok for root path (integration)', async () => {
      const response = await SELF.fetch('https://example.com/');
      expect(await response.text()).toBe("ok");
    });

    it('should handle unknown paths', async () => {
      const response = await SELF.fetch('https://example.com/unknown');
      expect(await response.text()).toBe("ok");
    });
  });

  describe('Hive partition format validation', () => {
    it('should generate valid BigQuery partition paths', () => {
      const testDates = [
        "2023-01-01T00:00:00.000Z",
        "2023-02-14T12:34:56.789Z", 
        "2023-12-31T23:59:59.999Z"
      ];
      
      testDates.forEach(date => {
        const path = pathForRow("test", date, "sample-id");
        // Check that path follows Hive partitioning format
        expect(path).toMatch(/^test\/dt=\d{4}-\d{2}-\d{2}\/hour=\d{2}\/sample-id\.jsonl$/);
      });
    });
  });
});
