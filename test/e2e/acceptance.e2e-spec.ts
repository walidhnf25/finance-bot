/**
 * ACCEPTANCE scenarios through the real HTTP webhook, the real NestJS app and a real PostgreSQL test
 * database. Only Telegram's outbound HTTP (a capturing fake) and the OCR engine (a stub) are substituted, so
 * this proves what the bot DOES with ordinary text, not how Telegram behaves.
 *
 * These are the situations an independent review (rounds 1 and 2) showed to be the real risk: plain
 * sentences that contain command-like words must never delete, overwrite or confirm anything.
 */
import sharp from 'sharp';
import { ReceiptOcr } from '../../src/modules/receipt/infrastructure/ocr';
import { resetDatabase } from '../setup/test-db';
import { buildUpdate, createTestApp, TestApp } from '../setup/test-app';

class StubOcr extends ReceiptOcr {
  text = 'WARUNG MAKAN\nNasi 10.000\nTeh 5.000\nTOTAL 15.000\nTUNAI 20.000';
  read(): Promise<string> {
    return Promise.resolve(this.text);
  }
}

const U = 8801;
let shade = 0;
const png = (): Promise<Buffer> =>
  sharp({
    create: {
      width: 70 + ++shade,
      height: 50,
      channels: 3,
      background: { r: shade, g: 60, b: 60 },
    },
  })
    .png()
    .toBuffer();

describe('acceptance: ordinary text never causes a destructive or wrong action', () => {
  let t: TestApp;
  const ocr = new StubOcr();

  beforeAll(async () => {
    t = await createTestApp({ RECEIPT_AI_MODE: 'never' }, (b) =>
      b.overrideProvider(ReceiptOcr).useValue(ocr),
    );
  });
  afterAll(async () => t.close());

  const say = async (text: string): Promise<string> => {
    t.telegram.clear();
    await t.say(U, text).expect(200);
    return t.telegram.texts.map((m) => m.text).join('\n---\n');
  };
  const user = () => t.prisma.user.findUniqueOrThrow({ where: { telegramId: String(U) } });
  const rows = async () =>
    t.prisma.transaction.findMany({
      where: {
        userId: (await user()).id,
        deletedAt: null,
        OR: [{ note: null }, { note: { not: 'SALDO_AWAL' } }],
      },
      orderBy: { createdAt: 'asc' },
    });
  const money = (minor: bigint) => Number(minor / 100n);

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.telegram.clear();
    ocr.text = 'WARUNG MAKAN\nNasi 10.000\nTeh 5.000\nTOTAL 15.000\nTUNAI 20.000';
    expect(await say('halo')).toContain('Selamat datang');
    expect(await say('3')).toContain('Berapa saldo'); // both wallets
    expect(await say('100rb')).toContain('Digital');
    expect(await say('500rb')).toContain('Siap!');
    await say('default cash'); // so ordinary expenses are recorded without a wallet question
  });

  it('income and expense are recorded with the right wallet and amount', async () => {
    expect(await say('gaji 5 juta')).toContain('Berhasil dicatat');
    expect(await say('beli kopi 25rb cash')).toContain('Berhasil dicatat');
    expect(await say('bayar listrik 150rb digital')).toContain('Berhasil dicatat');
    const r = await rows();
    expect(r.map((x) => [x.type, money(x.amountMinor)])).toEqual([
      ['INCOME', 5_000_000],
      ['EXPENSE', 25_000],
      ['EXPENSE', 150_000],
    ]);
    expect(r.map((x) => x.wallet)).toEqual(expect.arrayContaining(['CASH', 'DIGITAL']));
  });

  it('a transfer moves money between wallets and keeps the total', async () => {
    const before = await say('saldo');
    expect(await say('tarik tunai 100rb')).toContain('Transfer dicatat');
    const after = await say('saldo');
    const total = (s: string) => /Total: \*(Rp[\d.]+)\*/.exec(s)?.[1];
    expect(total(before)).toMatch(/^Rp[\d.]+$/); // both totals were actually read
    expect(total(after)).toMatch(/^Rp[\d.]+$/);
    expect(total(after)).toBe(total(before)); // a transfer never changes the total
    expect(after).not.toBe(before);
  });

  describe('the reset prompt', () => {
    it('"makan siang 30rb ya" after "reset" is a new expense, NOT a confirmation', async () => {
      await say('beli kopi 25rb');
      const before = (await rows()).length;
      expect(await say('reset')).toMatch(/yakin|hapus/i);
      const reply = await say('makan siang 30rb ya');
      expect(reply).toContain('Berhasil dicatat');
      const after = await rows();
      expect(after.length).toBe(before + 1); // nothing wiped, one expense added
      expect(after.some((x) => money(x.amountMinor) === 30_000)).toBe(true);
    });

    it.each(['jangan ya', 'tidak', 'batal', 'gak jadi'])(
      '"%s" cancels the reset and keeps every row',
      async (answer) => {
        await say('beli kopi 25rb');
        const before = (await rows()).length;
        await say('reset');
        await say(answer);
        expect((await rows()).length).toBe(before);
      },
    );

    it('only a plain "ya" wipes (positive control)', async () => {
      await say('beli kopi 25rb');
      expect(await rows()).toHaveLength(1); // there is something to lose
      await say('reset');
      await say('ya');
      expect(await rows()).toHaveLength(0);
    });
  });

  describe('words that look like commands inside a description', () => {
    it('"ganti oli motor 150rb" is an expense and leaves the previous transaction alone', async () => {
      await say('beli kopi 25rb');
      const first = (await rows())[0];
      await say('ganti oli motor 150rb');
      const r = await rows();
      expect(r).toHaveLength(2);
      expect(money(r[0].amountMinor)).toBe(25_000);
      expect(r[0].id).toBe(first.id);
      expect(money(r[1].amountMinor)).toBe(150_000);
    });

    it.each([
      ['ganti 2 ban motor 300rb', 300_000],
      ['beli menu makan siang 25rb', 25_000],
      ['bayar kabel reset router 50rb', 50_000],
    ])('"%s" is recorded as an expense of %d', async (text, amount) => {
      const before = (await rows()).length;
      expect(await say(text)).toContain('Berhasil dicatat');
      const r = await rows();
      expect(r).toHaveLength(before + 1);
      expect(money(r[r.length - 1].amountMinor)).toBe(amount);
    });

    it('a real edit still edits: "ubah jadi 40rb" changes the last amount', async () => {
      await say('beli kopi 25rb');
      await say('ubah jadi 40rb');
      const r = await rows();
      expect(r).toHaveLength(1);
      expect(money(r[0].amountMinor)).toBe(40_000);
    });

    it('a real delete still deletes the last one', async () => {
      await say('beli kopi 25rb');
      expect(await say('hapus')).toMatch(/yakin|hapus/i); // deleting asks first
      expect(await rows()).toHaveLength(1);
      await say('ya');
      expect(await rows()).toHaveLength(0);
    });
  });

  describe('several numbers in one message', () => {
    it.each([
      ['beli kopi 2 gelas 30000', 30_000],
      ['beras 25kg 300000', 300_000],
      ['makan 4 orang 200.000', 200_000],
      ['bayar parkir 2 jam 4000', 4_000],
    ])('"%s" is read as %d (the quantity is not the price)', async (text, amount) => {
      await say(text);
      const r = await rows();
      expect(money(r[r.length - 1].amountMinor)).toBe(amount);
    });

    it('a quantity alone is not an amount: nothing is recorded (it used to record Rp25)', async () => {
      const reply = await say('beras 25kg');
      expect(await rows()).toHaveLength(0);
      expect(reply).not.toContain('Berhasil dicatat');
    });
  });

  describe('invalid input', () => {
    it('refuses an absurd amount and records nothing', async () => {
      const reply = await say('beli mobil 99999999999999rb');
      expect(reply).toMatch(/terlalu besar|batas/i);
      expect(await rows()).toHaveLength(0);
    });

    it('refuses a message that is far too long, before parsing it', async () => {
      const reply = await say(`beli ${'kopi '.repeat(1_000)} 5rb`);
      expect(reply).toContain('terlalu panjang');
      expect(await rows()).toHaveLength(0);
    });

    it('rejects a photo that is not an image', async () => {
      t.telegram.files.set('FILE-NOT-IMAGE-1', Buffer.from('MZ definitely an executable'));
      t.telegram.clear();
      await t
        .deliver(
          buildUpdate(U, '', undefined, {
            text: undefined,
            photo: [
              {
                file_id: 'FILE-NOT-IMAGE-1',
                file_unique_id: 'u1',
                width: 10,
                height: 10,
                file_size: 30,
              },
            ],
          }),
        )
        .expect(200);
      expect(t.telegram.texts.map((m) => m.text).join(' ')).toMatch(
        /hanya bisa membaca foto JPG, PNG, atau WebP/,
      );
      expect(await t.prisma.receiptDraft.count()).toBe(0);
    });
  });

  it('the same Telegram update delivered twice is recorded once', async () => {
    const update = buildUpdate(U, 'beli bensin 40rb');
    await t.deliver(update).expect(200);
    await t.deliver(update).expect(200);
    expect(await rows()).toHaveLength(1);
  });

  describe('receipts', () => {
    const photo = async (id: string) => {
      const bytes = await png();
      t.telegram.files.set(id, bytes);
      return buildUpdate(U, '', undefined, {
        text: undefined,
        photo: [
          { file_id: id, file_unique_id: id, width: 70, height: 50, file_size: bytes.length },
        ],
      });
    };

    it('a photo makes a DRAFT only; "ya" records it once; a second "ya" does nothing', async () => {
      t.telegram.clear();
      await t.deliver(await photo('ACC-RECEIPT-0001')).expect(200);
      expect(t.telegram.last()).toContain('Rp15.000');
      expect(await rows()).toHaveLength(0);
      await say('ya');
      expect(await rows()).toHaveLength(1);
      await say('ya');
      expect(await rows()).toHaveLength(1);
    });

    it('a sentence that merely contains "ya" does NOT confirm a pending receipt', async () => {
      await t.deliver(await photo('ACC-RECEIPT-0002')).expect(200);
      expect(await say('makan siang 30rb ya')).toContain('Berhasil dicatat');
      const r = await rows();
      expect(r).toHaveLength(1); // only the typed expense, not the receipt too
      expect(money(r[0].amountMinor)).toBe(30_000);
      expect(await t.prisma.receiptDraft.count({ where: { status: 'PENDING' } })).toBe(1);
    });

    it('"jangan ya" cancels the draft instead of confirming it', async () => {
      await t.deliver(await photo('ACC-RECEIPT-0003')).expect(200);
      expect(await t.prisma.receiptDraft.count({ where: { status: 'PENDING' } })).toBe(1);
      await say('jangan ya');
      expect(await t.prisma.receiptDraft.count({ where: { status: 'CANCELLED' } })).toBe(1);
      expect(await rows()).toHaveLength(0);
      expect(await t.prisma.receiptDraft.count({ where: { status: 'CONFIRMED' } })).toBe(0);
    });

    it('an unreadable receipt gets a friendly answer and no draft', async () => {
      ocr.text = 'xx';
      t.telegram.clear();
      await t.deliver(await photo('ACC-RECEIPT-0004')).expect(200);
      expect(t.telegram.last()).toMatch(/belum bisa membaca/i);
      expect(await t.prisma.receiptDraft.count()).toBe(0);
    });

    it('the same photo sent twice never makes two transactions', async () => {
      const update = await photo('ACC-RECEIPT-0005');
      await t.deliver(update).expect(200);
      await t
        .deliver({
          ...update,
          update_id: update.update_id + 1000,
          message: { ...update.message!, message_id: update.message!.message_id + 1000 },
        })
        .expect(200);
      await say('ya');
      await say('ya');
      expect(await rows()).toHaveLength(1);
    });
  });
});
