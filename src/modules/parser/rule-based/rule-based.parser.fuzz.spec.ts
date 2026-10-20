/**
 * Generated-message check for the chat parser. The parser is heuristic, so the property that matters is
 * about harm, not accuracy: an ordinary expense sentence that merely CONTAINS a word such as "hapus",
 * "ganti" or "reset" must never turn into an intent that changes or deletes stored data. The generator is
 * a seeded PRNG so a failure prints the seed and the sentence and can be replayed.
 */
import { IntentType, ParsedIntent } from '../domain/parsed-intent';
import { RuleBasedParser } from './rule-based.parser';

const TZ = 'Asia/Jakarta';
const NOW = new Date('2026-07-15T03:00:00.000Z');
const SEED = 20261018;
const CASES = 4_000;

/** mulberry32: small, fast, deterministic. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)];

/** Intents that change or delete data the user did not just ask to change. */
const DESTRUCTIVE = new Set<IntentType>([
  IntentType.EditTransaction,
  IntentType.DeleteTransaction,
  IntentType.DeleteTransfer,
  IntentType.ResetData,
  IntentType.SetBudget,
  IntentType.SetOpeningBalance,
  IntentType.SetupWallets,
  IntentType.SetDefaultWallet,
  IntentType.Transfer,
]);

const VERBS = ['beli', 'bayar', 'makan', 'isi', 'servis', 'ongkos', 'traktir', 'sewa'] as const;
const NOUNS = [
  'kopi susu',
  'oli motor',
  'tiket kereta',
  'sabun cuci',
  'kabel data',
  'pulsa',
  'bensin',
  'parkir mall',
  'obat flu',
] as const;
/** Words that are commands only at the START of a message; here they sit inside a sentence. */
const COMMAND_WORDS = [
  'hapus',
  'reset',
  'ganti',
  'ubah',
  'edit',
  'koreksi',
  'batal',
  'batalkan',
  'budget',
  'saldo awal',
  'pindah',
  'transfer',
  'tarik',
  'default',
  'atur dompet',
] as const;
const AMOUNTS = ['5rb', '12.500', '25 ribu', '150rb', '1,5jt', '2 juta', '300000'] as const;

describe('RuleBasedParser: generated expense sentences never become data-changing commands', () => {
  const parser = new RuleBasedParser();

  it(`keeps ${CASES} sentences with a command word in the middle as ordinary records`, async () => {
    const r = rng(SEED);
    const failures: string[] = [];
    for (let i = 0; i < CASES; i += 1) {
      // verb, a noun phrase, the command word in the middle, then more words and an amount at the end
      const text = [
        pick(r, VERBS),
        pick(r, NOUNS),
        pick(r, COMMAND_WORDS),
        pick(r, NOUNS),
        pick(r, AMOUNTS),
      ].join(' ');
      const intent: ParsedIntent = await parser.parse({ text, now: NOW, timezone: TZ });
      if (DESTRUCTIVE.has(intent.type)) failures.push(`${intent.type}: "${text}"`);
    }
    // Print a handful, not thousands: enough to replay with the seed.
    expect(failures.slice(0, 10)).toEqual([]);
  });

  it('never throws and always returns an intent for arbitrary short noise', async () => {
    const r = rng(SEED + 1);
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 .,/-:*_[]()<>Rp$%';
    for (let i = 0; i < 2_000; i += 1) {
      const length = 1 + Math.floor(r() * 60);
      let text = '';
      for (let j = 0; j < length; j += 1) text += alphabet[Math.floor(r() * alphabet.length)];
      const intent = await parser.parse({ text, now: NOW, timezone: TZ });
      expect(Object.values(IntentType)).toContain(intent.type);
    }
  });
});
