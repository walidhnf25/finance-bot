import { toIsoDate } from 'src/shared/utils/date.util';
import { BudgetPeriod, TransactionType, Wallet, WalletMode } from 'src/shared/domain/enums';
import { IntentType, ParsedIntent, SummaryPeriod } from '../domain/parsed-intent';
import { RuleBasedParser } from './rule-based.parser';

const TZ = 'Asia/Jakarta';
// Wednesday 2026-07-15, 10:00 WIB.
const NOW = new Date('2026-07-15T03:00:00.000Z');

describe('RuleBasedParser', () => {
  const parser = new RuleBasedParser();
  const parse = (text: string): Promise<ParsedIntent> =>
    parser.parse({ text, now: NOW, timezone: TZ });

  describe('record expense', () => {
    it('parses "Beli kopi 25 ribu"', async () => {
      const intent = await parse('Beli kopi 25 ribu');
      expect(intent.type).toBe(IntentType.RecordTransaction);
      if (intent.type !== IntentType.RecordTransaction) return;
      expect(intent.transactionType).toBe(TransactionType.EXPENSE);
      expect(intent.amount?.toNumber()).toBe(25000);
      expect(intent.keywords).toContain('kopi');
      expect(toIsoDate(intent.occurredAt, TZ)).toBe('2026-07-15');
    });

    it('parses "Isi bensin 100rb" and strips the verb', async () => {
      const intent = await parse('Isi bensin 100rb');
      expect(intent.type).toBe(IntentType.RecordTransaction);
      if (intent.type !== IntentType.RecordTransaction) return;
      expect(intent.transactionType).toBe(TransactionType.EXPENSE);
      expect(intent.amount?.toNumber()).toBe(100000);
      expect(intent.keywords).toContain('bensin');
    });

    it('parses expense with a relative date "makan bakso kemarin 15rb"', async () => {
      const intent = await parse('makan bakso kemarin 15rb');
      expect(intent.type).toBe(IntentType.RecordTransaction);
      if (intent.type !== IntentType.RecordTransaction) return;
      expect(intent.amount?.toNumber()).toBe(15000);
      expect(intent.keywords).toContain('bakso');
      expect(toIsoDate(intent.occurredAt, TZ)).toBe('2026-07-14');
    });

    it('asks for clarification when amount is missing ("Beli kopi")', async () => {
      const intent = await parse('Beli kopi');
      expect(intent.type).toBe(IntentType.RecordTransaction);
      if (intent.type !== IntentType.RecordTransaction) return;
      expect(intent.amount).toBeNull();
      expect(intent.keywords).toContain('kopi');
    });
  });

  describe('record income', () => {
    it('parses "Gaji 8 juta" as income', async () => {
      const intent = await parse('Gaji 8 juta');
      expect(intent.type).toBe(IntentType.RecordTransaction);
      if (intent.type !== IntentType.RecordTransaction) return;
      expect(intent.transactionType).toBe(TransactionType.INCOME);
      expect(intent.amount?.toNumber()).toBe(8_000_000);
      expect(intent.keywords).toContain('gaji');
    });

    it('parses "dapat bonus 500rb" as income', async () => {
      const intent = await parse('dapat bonus 500rb');
      expect(intent.type).toBe(IntentType.RecordTransaction);
      if (intent.type !== IntentType.RecordTransaction) return;
      expect(intent.transactionType).toBe(TransactionType.INCOME);
      expect(intent.amount?.toNumber()).toBe(500000);
    });
  });

  describe('amount-only (clarification reply)', () => {
    it('parses a bare "25 ribu"', async () => {
      const intent = await parse('25 ribu');
      expect(intent.type).toBe(IntentType.AmountOnly);
      if (intent.type !== IntentType.AmountOnly) return;
      expect(intent.amount.toNumber()).toBe(25000);
    });
  });

  describe('summary', () => {
    it.each([
      ['ringkasan hari ini', SummaryPeriod.Day],
      ['rekap minggu ini', SummaryPeriod.Week],
      ['Ringkasan bulan ini', SummaryPeriod.Month],
      ['laporan', SummaryPeriod.Month],
    ])('parses "%s"', async (text, period) => {
      const intent = await parse(text);
      expect(intent.type).toBe(IntentType.Summary);
      if (intent.type !== IntentType.Summary) return;
      expect(intent.period).toBe(period);
    });
  });

  describe('budget', () => {
    it('parses "Budget makan 2 juta"', async () => {
      const intent = await parse('Budget makan 2 juta');
      expect(intent.type).toBe(IntentType.SetBudget);
      if (intent.type !== IntentType.SetBudget) return;
      expect(intent.amount?.toNumber()).toBe(2_000_000);
      expect(intent.keywords).toContain('makan');
      expect(intent.period).toBe(BudgetPeriod.MONTHLY);
    });

    it('detects a weekly budget period', async () => {
      const intent = await parse('anggaran jajan mingguan 200rb');
      expect(intent.type).toBe(IntentType.SetBudget);
      if (intent.type !== IntentType.SetBudget) return;
      expect(intent.period).toBe(BudgetPeriod.WEEKLY);
    });
  });

  describe('other commands', () => {
    it('parses delete', async () => {
      expect((await parse('hapus')).type).toBe(IntentType.DeleteTransaction);
      expect((await parse('batalkan transaksi terakhir')).type).toBe(IntentType.DeleteTransaction);
    });

    it('parses edit with a new amount', async () => {
      const intent = await parse('edit jadi 30rb');
      expect(intent.type).toBe(IntentType.EditTransaction);
      if (intent.type !== IntentType.EditTransaction) return;
      expect(intent.amount?.toNumber()).toBe(30000);
    });

    it('parses export', async () => {
      const intent = await parse('export bulan ini');
      expect(intent.type).toBe(IntentType.Export);
    });

    it('parses help and greeting', async () => {
      expect((await parse('help')).type).toBe(IntentType.Help);
      expect((await parse('bantuan')).type).toBe(IntentType.Help);
      expect((await parse('halo')).type).toBe(IntentType.Greeting);
    });

    it('returns Unknown for gibberish', async () => {
      expect((await parse('asdfghjkl')).type).toBe(IntentType.Unknown);
    });
  });

  describe('wallets', () => {
    it.each([
      ['beli kopi 25rb cash', Wallet.CASH],
      ['bayar tunai bakso 15rb', Wallet.CASH],
      ['gaji 5 juta transfer', Wallet.DIGITAL],
      ['bensin 50rb gopay', Wallet.DIGITAL],
      ['makan siang 30rb qris', Wallet.DIGITAL],
    ])('detects the wallet in "%s"', async (text, wallet) => {
      const intent = await parse(text);
      expect(intent.type).toBe(IntentType.RecordTransaction);
      if (intent.type !== IntentType.RecordTransaction) return;
      expect(intent.wallet).toBe(wallet);
    });

    it('leaves wallet null when none is named and keeps it out of keywords', async () => {
      const plain = await parse('beli kopi 25rb');
      const named = await parse('beli kopi 25rb cash');
      if (plain.type !== IntentType.RecordTransaction) throw new Error('unexpected intent');
      if (named.type !== IntentType.RecordTransaction) throw new Error('unexpected intent');
      expect(plain.wallet).toBeNull();
      expect(named.keywords).toEqual(plain.keywords);
      expect(named.description).toBe('kopi');
    });

    it('keeps the wallet when the amount is still missing', async () => {
      const intent = await parse('beli kopi cash');
      if (intent.type !== IntentType.RecordTransaction) throw new Error('unexpected intent');
      expect(intent.amount).toBeNull();
      expect(intent.wallet).toBe(Wallet.CASH);
    });

    it('does not treat "cashback" as a wallet', async () => {
      const intent = await parse('cashback 5rb');
      if (intent.type !== IntentType.RecordTransaction) throw new Error('unexpected intent');
      expect(intent.wallet).toBeNull();
    });

    it('parses the balance command', async () => {
      expect((await parse('saldo')).type).toBe(IntentType.Balance);
      expect((await parse('cek saldo')).type).toBe(IntentType.Balance);
    });

    it('parses opening balance', async () => {
      const intent = await parse('saldo awal cash 200rb');
      expect(intent.type).toBe(IntentType.SetOpeningBalance);
      if (intent.type !== IntentType.SetOpeningBalance) return;
      expect(intent.wallet).toBe(Wallet.CASH);
      expect(intent.amount?.toNumber()).toBe(200000);
    });

    it.each(['saldo awal digital 0', 'saldo awal digital nol', 'saldo awal digital rp0'])(
      'accepts zero as an opening balance: "%s"',
      async (text) => {
        const intent = await parse(text);
        if (intent.type !== IntentType.SetOpeningBalance) throw new Error('unexpected intent');
        expect(intent.wallet).toBe(Wallet.DIGITAL);
        expect(intent.amount?.toNumber()).toBe(0);
      },
    );

    it('still asks for an amount when none is given', async () => {
      const intent = await parse('saldo awal digital');
      if (intent.type !== IntentType.SetOpeningBalance) throw new Error('unexpected intent');
      expect(intent.amount).toBeNull();
    });

    it('parses opening balance with a missing wallet', async () => {
      const intent = await parse('saldo awal 200rb');
      if (intent.type !== IntentType.SetOpeningBalance) throw new Error('unexpected intent');
      expect(intent.wallet).toBeNull();
    });

    it('parses the default wallet command', async () => {
      const intent = await parse('default digital');
      expect(intent.type).toBe(IntentType.SetDefaultWallet);
      if (intent.type !== IntentType.SetDefaultWallet) return;
      expect(intent.wallet).toBe(Wallet.DIGITAL);
    });

    it('parses a wallet change on edit', async () => {
      const intent = await parse('edit ke digital');
      expect(intent.type).toBe(IntentType.EditTransaction);
      if (intent.type !== IntentType.EditTransaction) return;
      expect(intent.wallet).toBe(Wallet.DIGITAL);
      expect(intent.keywords).toEqual([]);
    });
  });

  describe('several transactions in one message', () => {
    const manyOf = async (text: string) => {
      const intent = await parse(text);
      if (intent.type !== IntentType.RecordMany) throw new Error(`not a batch: ${text}`);
      return intent;
    };

    it('reads "beli ayam 8 ribu, beli es teh manis 5 ribu" as two expenses', async () => {
      const { items } = await manyOf('beli ayam 8 ribu, beli es teh manis 5 ribu');

      expect(items).toHaveLength(2);
      expect(items.map((i) => i.amount?.toNumber())).toEqual([8000, 5000]);
      expect(items.map((i) => i.transactionType)).toEqual([
        TransactionType.EXPENSE,
        TransactionType.EXPENSE,
      ]);
      expect(items[0].keywords).toContain('ayam');
      expect(items[1].keywords).toContain('es teh manis');
      expect(items.map((i) => i.raw)).toEqual(['beli ayam 8 ribu', 'beli es teh manis 5 ribu']);
    });

    it('accepts line breaks, semicolons and three or more items', async () => {
      expect((await manyOf('beli ayam 8rb\nbeli es teh 5rb')).items).toHaveLength(2);
      expect((await manyOf('beli ayam 8rb; beli es teh 5rb')).items).toHaveLength(2);
      const three = await manyOf('kopi 5rb, teh 4rb, roti 3rb');
      expect(three.items.map((i) => i.amount?.toNumber())).toEqual([5000, 4000, 3000]);
    });

    it('mixes income and expense', async () => {
      const { items } = await manyOf('gaji 5 juta, beli kopi 10rb');
      expect(items.map((i) => i.transactionType)).toEqual([
        TransactionType.INCOME,
        TransactionType.EXPENSE,
      ]);
    });

    it('does not split a decimal comma inside an amount', async () => {
      const { items } = await manyOf('beli laptop 1,5jt, beli mouse 200rb');
      expect(items.map((i) => i.amount?.toNumber())).toEqual([1500000, 200000]);
    });

    it('gives every item its own date', async () => {
      const { items } = await manyOf('beli ayam 8rb kemarin, beli teh 5rb');
      expect(toIsoDate(items[0].occurredAt, TZ)).toBe('2026-07-14');
      expect(toIsoDate(items[1].occurredAt, TZ)).toBe('2026-07-15');
    });

    it('applies a wallet named once to the items that name none', async () => {
      const shared = await manyOf('beli ayam 8rb, beli es teh 5rb cash');
      expect(shared.items.map((i) => i.wallet)).toEqual([Wallet.CASH, Wallet.CASH]);

      const none = await manyOf('beli ayam 8rb, beli es teh 5rb');
      expect(none.items.map((i) => i.wallet)).toEqual([null, null]);
    });

    it('keeps different wallets apart, leaving unnamed items to the default', async () => {
      const mixed = await manyOf('ayam 8rb cash, teh 5rb qris, roti 3rb');
      expect(mixed.items.map((i) => i.wallet)).toEqual([Wallet.CASH, Wallet.DIGITAL, null]);
    });

    it('is not fooled by a list of items sharing one price', async () => {
      const intent = await parse('beli nasi, ayam 25rb');
      expect(intent.type).toBe(IntentType.RecordTransaction);
      if (intent.type !== IntentType.RecordTransaction) return;
      expect(intent.amount?.toNumber()).toBe(25000);
    });

    it('keeps a comma before the amount as one transaction', async () => {
      const intent = await parse('beli kopi, 25rb');
      expect(intent.type).toBe(IntentType.RecordTransaction);
    });

    it('needs an amount in every part, otherwise parses the message whole', async () => {
      expect((await parse('beli ayam 8rb, beli es teh')).type).not.toBe(IntentType.RecordMany);
      expect((await parse('beli ayam 8rb, 5rb')).type).not.toBe(IntentType.RecordMany);
    });

    it('leaves commands that contain commas alone', async () => {
      expect((await parse('ringkasan bulan ini, minggu ini')).type).toBe(IntentType.Summary);
      expect((await parse('export bulan ini, minggu ini')).type).toBe(IntentType.Export);
    });

    it('leaves single messages exactly as before', async () => {
      const intent = await parse('beli kopi 25rb');
      expect(intent.type).toBe(IntentType.RecordTransaction);
    });
  });

  describe('wallet setup', () => {
    it.each(['atur dompet', 'pilih dompet', 'setup dompet', 'pengaturan dompet'])(
      'starts the setup question on "%s"',
      async (text) => {
        expect((await parse(text)).type).toBe(IntentType.SetupWallets);
      },
    );

    it('does not treat other wallet commands as setup', async () => {
      expect((await parse('default digital')).type).toBe(IntentType.SetDefaultWallet);
      expect((await parse('saldo awal cash 200rb')).type).toBe(IntentType.SetOpeningBalance);
      expect((await parse('atur budget makan 2 juta')).type).toBe(IntentType.SetBudget);
    });

    it.each([
      ['1', WalletMode.CASH],
      ['cash saja', WalletMode.CASH],
      ['tunai', WalletMode.CASH],
      ['2', WalletMode.DIGITAL],
      ['digital', WalletMode.DIGITAL],
      ['qris saja', WalletMode.DIGITAL],
      ['3', WalletMode.BOTH],
      ['keduanya', WalletMode.BOTH],
      ['cash dan digital', WalletMode.BOTH],
      ['digital dan cash', WalletMode.BOTH],
    ])('reads "%s" as the wallet answer %s', (text, mode) => {
      expect(parser.parseWalletMode(text)).toBe(mode);
    });

    it('returns null for an unclear answer', () => {
      expect(parser.parseWalletMode('hmm')).toBeNull();
      expect(parser.parseWalletMode('5')).toBeNull();
    });
  });

  describe('transfers', () => {
    const transferOf = async (text: string) => {
      const intent = await parse(text);
      if (intent.type !== IntentType.Transfer) throw new Error(`not a transfer: ${text}`);
      return intent;
    };

    it.each([
      ['tarik tunai 500rb', Wallet.DIGITAL, Wallet.CASH, 500000],
      ['tarik 1 juta', Wallet.DIGITAL, Wallet.CASH, 1000000],
      ['setor tunai 200rb', Wallet.CASH, Wallet.DIGITAL, 200000],
      ['pindah 300rb dari cash ke digital', Wallet.CASH, Wallet.DIGITAL, 300000],
      ['pindahkan 300rb dari digital ke cash', Wallet.DIGITAL, Wallet.CASH, 300000],
      ['pindah 300rb ke cash', Wallet.DIGITAL, Wallet.CASH, 300000],
      ['pindah 300rb dari cash', Wallet.CASH, Wallet.DIGITAL, 300000],
    ])('parses "%s"', async (text, from, to, amount) => {
      const intent = await transferOf(text);
      expect(intent.from).toBe(from);
      expect(intent.to).toBe(to);
      expect(intent.amount?.toNumber()).toBe(amount);
    });

    it('leaves gaps for the bot to ask about', async () => {
      const noDirection = await transferOf('pindah 300rb');
      expect(noDirection.from).toBeNull();
      expect(noDirection.to).toBeNull();
      const noAmount = await transferOf('tarik tunai');
      expect(noAmount.amount).toBeNull();
    });

    it('parses deleting the latest transfer', async () => {
      expect((await parse('hapus transfer')).type).toBe(IntentType.DeleteTransfer);
      expect((await parse('batal pindah')).type).toBe(IntentType.DeleteTransfer);
      expect((await parse('hapus transfer terakhir')).type).toBe(IntentType.DeleteTransfer);
    });

    it('does not confuse ordinary messages with transfers', async () => {
      expect((await parse('hapus bensin transfer')).type).toBe(IntentType.DeleteTransaction);
      expect((await parse('hapus')).type).toBe(IntentType.DeleteTransaction);
      expect((await parse('gaji 5 juta transfer')).type).toBe(IntentType.RecordTransaction);
      expect((await parse('setor 100rb')).type).not.toBe(IntentType.Transfer);
    });
  });

  describe('parseAmount (clarification helper)', () => {
    it('extracts a bare amount', () => {
      expect(parser.parseAmount('25 ribu')?.toNumber()).toBe(25000);
      expect(parser.parseAmount('tidak ada angka')).toBeNull();
    });
  });
});

// Regression: delete/edit words used to hijack ANY message that contained them.
describe('RuleBasedParser: delete and edit are commands only at the start of a message', () => {
  const parser = new RuleBasedParser();
  const parse = (text: string): Promise<ParsedIntent> =>
    parser.parse({ text, now: NOW, timezone: TZ });

  it.each([
    'ganti oli motor 150rb',
    'beli sabun hapus noda 20rb',
    'ubah warna rambut 200rb',
    'ongkos revisi skripsi 50rb',
    'bayar koreksi kacamata 300rb',
    'servis ganti ban 400rb',
    // the command word is NOT among the first two words, even when a number follows it
    'beli kopi susu ganti 20rb',
    'makan siang edit 15rb',
    'bayar parkir mall ubah 5rb',
    'isi bensin motor batal 20rb',
  ])('records "%s" as an expense instead of changing or deleting stored data', async (text) => {
    const intent = await parse(text);
    expect(intent.type).toBe(IntentType.RecordTransaction);
  });

  it.each([
    ['edit jadi 30rb', IntentType.EditTransaction],
    ['ganti jadi 40rb', IntentType.EditTransaction],
    ['ubah 35rb', IntentType.EditTransaction],
    ['ubah kategori ke makan', IntentType.EditTransaction],
    ['tolong ganti nominal 50rb', IntentType.EditTransaction],
    ['koreksi', IntentType.EditTransaction],
    ['hapus', IntentType.DeleteTransaction],
    ['tolong hapus transaksi terakhir', IntentType.DeleteTransaction],
    ['batalkan transaksi terakhir', IntentType.DeleteTransaction],
  ])('still treats "%s" as a command', async (text, type) => {
    expect((await parse(text)).type).toBe(type);
  });
});

// Regression: "ganti 2 ban motor 300rb" starts with a number but is an expense; help, reset and
// budget words inside a description must not hijack the message.
describe('RuleBasedParser: commands that look like descriptions', () => {
  const parser = new RuleBasedParser();
  const parse = (text: string): Promise<ParsedIntent> =>
    parser.parse({ text, now: NOW, timezone: TZ });

  it.each([
    'ganti 2 ban motor 300rb',
    'ubah 3 filter oli 150rb',
    'ganti 4 baut 20rb',
    'beli menu makan siang 25rb',
    'bayar kabel pengaman reset router 50rb',
    'beli kabel pengaman batas 50rb',
    'servis ac 1 kali 200rb mulai kemarin',
  ])('records "%s" as an expense', async (text) => {
    expect((await parse(text)).type).toBe(IntentType.RecordTransaction);
  });

  it.each([
    ['ganti 50rb ke digital', IntentType.EditTransaction],
    ['ubah 35 rb', IntentType.EditTransaction],
    ['koreksi jadi 40rb', IntentType.EditTransaction],
    ['reset', IntentType.ResetData],
    ['reset data', IntentType.ResetData],
    ['hapus semua', IntentType.ResetData],
    ['help', IntentType.Help],
    ['menu', IntentType.Help],
    ['cara pakai', IntentType.Help],
    ['atur budget makan 2 juta', IntentType.SetBudget],
    ['anggaran jajan mingguan 200rb', IntentType.SetBudget],
  ])('still treats "%s" as a command', async (text, type) => {
    expect((await parse(text)).type).toBe(type);
  });
});
