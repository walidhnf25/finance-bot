import { interpretYesNo } from './yes-no';

describe('interpretYesNo', () => {
  it.each([
    'ya',
    'Ya',
    'YA',
    'iya',
    'ok',
    'oke',
    'sip',
    'y',
    'benar',
    'ya.',
    'ok!',
    'ya, simpan',
    '  ya  ',
    'oke deh',
    'ya catat aja',
    'iya betul',
  ])('reads %j as yes', (text) => expect(interpretYesNo(text)).toBe('yes'));

  it.each([
    'tidak',
    'no',
    'batal',
    'jangan',
    'gak',
    'n',
    'bukan',
    'cancel',
    'stop',
    'batal.',
    'tidak!',
    'gak jadi',
    'tidak usah',
  ])('reads %j as no', (text) => expect(interpretYesNo(text)).toBe('no'));

  // Regression: an agreement word next to a negation used to win.
  it.each([
    'jangan ya',
    'tidak ya',
    'batal, bukan ok',
    'ya jangan',
    'ok batal',
    'gak jadi, ya?',
    'JANGAN YA',
    'stop, ok',
  ])('NEVER reads %j as yes (a negation always wins)', (text) =>
    expect(interpretYesNo(text)).toBe('no'),
  );

  // Regression: a yes word anywhere in a sentence used to confirm (and "reset" is a hard delete).
  it.each([
    'makan siang 30rb ya',
    'beli kopi 25rb ok',
    'ya itu beli kopi tadi pagi',
    'reset ya',
    'ya hapus semua transaksi',
    'oke tolong catat belanja bulanan',
    'sip 5rb',
    'ya 2',
    'mungkin ya',
    'ok deh nanti saja ya',
    'ya ya ya ya ya', // a run of yes words is not an answer either
  ])('does NOT treat the sentence %j as a confirmation', (text) =>
    expect(interpretYesNo(text)).not.toBe('yes'),
  );

  // ...and the same discipline for "no": a long sentence with a negation word is a new message, not a cancel.
  it.each([
    'beli es teh tidak pakai gula 5rb',
    'jangan lupa catat bensin 20rb',
    'tidak ada makan siang hari ini ya',
    'gak 5rb', // a number means it is an amount, not an answer
    'jangan 20rb',
    'tidak tidak tidak tidak tidak',
  ])('does NOT treat the sentence %j as a cancel', (text) =>
    expect(interpretYesNo(text)).toBeNull(),
  );

  it.each(['', '   ', 'mungkin', 'beli kopi 25rb', 'yaaa', '123'])(
    'reads %j as no answer',
    (text) => expect(interpretYesNo(text)).toBeNull(),
  );
});
