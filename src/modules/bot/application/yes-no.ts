import { tokenize } from 'src/shared/utils/string-normalizer';

const YES_WORDS = new Set([
  'ya',
  'iya',
  'yoi',
  'yes',
  'yup',
  'yap',
  'ok',
  'oke',
  'sip',
  'benar',
  'y',
]);
/** Words that may sit next to a yes without changing its meaning ("ya simpan", "oke deh"). */
const YES_FILLER = new Set([
  'deh',
  'dong',
  'aja',
  'saja',
  'banget',
  'simpan',
  'catat',
  'catatkan',
  'betul',
  'bener',
  'tolong',
  'gas',
  'lanjut',
  'lanjutkan',
  'mantap',
  'sudah',
  'udah',
  'siap',
  'boleh',
  'silakan',
  'bisa',
  'jadi',
]);
const NO_WORDS = new Set([
  'tidak',
  'ga',
  'gak',
  'nggak',
  'engga',
  'enggak',
  'no',
  'nope',
  'batal',
  'jangan',
  'bukan',
  'cancel',
  'stop',
  'n',
]);

/** A reply longer than this is a sentence, not an answer. */
const MAX_REPLY_TOKENS = 4;

/**
 * Reads a confirmation reply. It is deliberately strict, because "ya" releases things that cannot be undone
 * cheaply (recording a receipt, deleting, a full data reset):
 *
 *  - only a SHORT message can be an answer (at most four words, no digits): "makan siang 30rb ya" is a new
 *    expense, not a confirmation;
 *  - "yes" needs every word to be a yes word or a harmless filler ("ya", "oke deh", "ya simpan"); any other
 *    word ("ya itu beli kopi", "reset ya") means it is NOT a plain confirmation;
 *  - a negation ALWAYS wins over an agreement word ("jangan ya", "tidak, bukan ok") and trailing punctuation is
 *    ignored ("ya." counts).
 *
 * null = not an answer: the caller treats the message as an ordinary new message.
 */
export function interpretYesNo(text: string): 'yes' | 'no' | null {
  const tokens = tokenize(text)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((t) => t.length > 0);
  if (tokens.length === 0 || tokens.length > MAX_REPLY_TOKENS) return null;
  if (tokens.some((t) => /\d/.test(t))) return null;
  if (tokens.some((t) => NO_WORDS.has(t))) return 'no';
  if (
    tokens.some((t) => YES_WORDS.has(t)) &&
    tokens.every((t) => YES_WORDS.has(t) || YES_FILLER.has(t))
  ) {
    return 'yes';
  }
  return null;
}
