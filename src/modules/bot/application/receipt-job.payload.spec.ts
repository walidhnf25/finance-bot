import { RejectedJobError } from 'src/modules/queue/domain/job-queue';
import { parseReceiptJob, receiptJobId } from './receipt-job.payload';

const NOW = new Date('2026-10-16T10:00:00.000Z');
const good = () => ({
  userId: '3f2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7b',
  chatId: '7001',
  messageId: '7001:1002',
  fileId: 'AgACAgUAAxkBAAIB',
  sizeBytes: 123_456,
  receivedAt: '2026-10-16T09:59:00.000Z',
});
const code = (data: unknown): string => {
  try {
    parseReceiptJob(data, NOW);
  } catch (e) {
    if (e instanceof RejectedJobError) return e.code;
    throw e;
  }
  return 'accepted';
};

describe('parseReceiptJob (the consumer trusts nothing that came out of Redis)', () => {
  it('accepts exactly what the producer writes', () => {
    expect(parseReceiptJob({ ...good(), correlationId: 'abc-123' }, NOW)).toMatchObject(good());
    expect(code({ ...good(), sizeBytes: undefined })).toBe('accepted');
  });

  it.each([
    [null, 'not_an_object'],
    ['text', 'not_an_object'],
    [[1, 2], 'not_an_object'],
    [{ ...good(), extra: 1 }, 'unexpected_field'],
    [JSON.parse('{"__proto__":{"x":1},"userId":"x"}'), 'unexpected_field'],
    [{ ...good(), userId: 'not-a-uuid' }, 'bad_user'],
    [{ ...good(), userId: 5 }, 'bad_user'],
    [{ ...good(), chatId: '-100123' }, 'bad_chat'], // a group
    [{ ...good(), chatId: '12abc' }, 'bad_chat'],
    [{ ...good(), chatId: 7001 }, 'bad_chat'],
    [{ ...good(), messageId: 'a b' }, 'bad_message'],
    [{ ...good(), messageId: 'x'.repeat(65) }, 'bad_message'],
    [{ ...good(), fileId: '../../etc/passwd' }, 'bad_file'],
    [{ ...good(), fileId: 'short' }, 'bad_file'],
    [{ ...good(), fileId: 'A'.repeat(201) }, 'bad_file'],
    [{ ...good(), sizeBytes: -1 }, 'bad_size'],
    [{ ...good(), sizeBytes: 1.5 }, 'bad_size'],
    [{ ...good(), sizeBytes: 10 ** 12 }, 'bad_size'],
    [{ ...good(), sizeBytes: '5' }, 'bad_size'],
    [{ ...good(), receivedAt: 'yesterday' }, 'bad_time'],
    [{ ...good(), receivedAt: '2020-01-01T00:00:00Z' }, 'bad_time'],
    [{ ...good(), receivedAt: '2030-01-01T00:00:00Z' }, 'bad_time'],
    [{ ...good(), receivedAt: 123 }, 'bad_time'],
    [{ ...good(), correlationId: 'x'.repeat(101) }, 'bad_correlation'],
  ])('rejects %j as %s', (data, expected) => expect(code(data)).toBe(expected));

  it('never puts the offending payload into the error', () => {
    try {
      parseReceiptJob({ ...good(), fileId: 'SECRET-../../etc' }, NOW);
    } catch (e) {
      expect(String(e)).not.toContain('SECRET');
    }
  });
});

describe('receiptJobId', () => {
  it('has no colon (BullMQ forbids it) and is stable per message', () => {
    expect(receiptJobId('7001:1002')).toBe('receipt-7001-1002');
    expect(receiptJobId('7001:1002')).toBe(receiptJobId('7001:1002'));
    expect(receiptJobId('a:b/c d')).not.toMatch(/[: /]/);
  });
});
