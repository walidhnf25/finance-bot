import ExcelJS from 'exceljs';
import { CategoryRepository } from 'src/modules/category/domain/category.repository';
import { SummaryPeriod } from 'src/modules/parser/domain/parsed-intent';
import { TransactionEntity } from 'src/modules/transaction/domain/transaction.entity';
import { TransactionRepository } from 'src/modules/transaction/domain/transaction.repository';
import { TransactionType, Wallet, WalletMode } from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';
import { CsvExportService } from './csv-export.service';

function tx(over: Partial<TransactionEntity> = {}): TransactionEntity {
  return {
    id: 't',
    userId: 'u1',
    categoryId: 'cat-food',
    type: TransactionType.EXPENSE,
    amount: Money.fromMajor(25000),
    description: 'kopi',
    note: null,
    occurredAt: new Date('2026-07-15T05:00:00.000Z'),
    sourceMessage: '',
    messageId: 'w',
    wallet: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe('CsvExportService (xlsx)', () => {
  let transactions: jest.Mocked<TransactionRepository>;
  let categories: jest.Mocked<CategoryRepository>;
  let service: CsvExportService;

  async function load(buf: Buffer): Promise<ExcelJS.Workbook> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    return wb;
  }

  beforeEach(() => {
    transactions = {
      findManyInRange: jest.fn(),
    } as unknown as jest.Mocked<TransactionRepository>;
    categories = { findById: jest.fn() } as unknown as jest.Mocked<CategoryRepository>;
    service = new CsvExportService(transactions, categories);
  });

  it('builds a transaction sheet sorted by date with numeric amounts', async () => {
    transactions.findManyInRange.mockResolvedValue([
      tx({ description: 'kopi susu', occurredAt: new Date('2026-07-16T05:00:00.000Z') }),
      tx({ description: 'nasi, ayam', occurredAt: new Date('2026-07-15T05:00:00.000Z') }),
    ]);
    categories.findById.mockResolvedValue({ name: 'Makanan' } as never);

    const out = await service.export('u1', SummaryPeriod.Month, new Date(), 'Asia/Jakarta');
    expect(out.rowCount).toBe(2);
    expect(out.filename).toBe('transaksi-bulan-ini.xlsx');
    expect(out.mimeType).toContain('spreadsheetml');

    const sheet = (await load(out.content)).getWorksheet('Transaksi')!;
    expect(sheet.getRow(4).values).toEqual([
      undefined,
      'Tanggal',
      'Tipe',
      'Jumlah',
      'Deskripsi',
      'Kategori',
    ]);
    expect(sheet.getRow(5).getCell(1).value).toBe('15/07/2026');
    expect(sheet.getRow(5).getCell(3).value).toBe(25000);
    expect(sheet.getRow(5).getCell(4).value).toBe('nasi, ayam');
    expect(sheet.getRow(6).getCell(4).value).toBe('kopi susu');
    expect(sheet.getRow(6).getCell(5).value).toBe('Makanan');
    expect(categories.findById).toHaveBeenCalledTimes(1);
  });

  it('adds a summary below the table with totals and category breakdown', async () => {
    transactions.findManyInRange.mockResolvedValue([
      tx({
        description: 'gaji',
        type: TransactionType.INCOME,
        amount: Money.fromMajor(100000),
        categoryId: null,
      }),
      tx({ description: 'kopi', amount: Money.fromMajor(25000) }),
      tx({ description: 'makan', amount: Money.fromMajor(75000) }),
    ]);
    categories.findById.mockResolvedValue({ name: 'Makanan' } as never);

    const out = await service.export('u1', SummaryPeriod.Month, new Date(), 'Asia/Jakarta');
    const sheet = (await load(out.content)).getWorksheet('Transaksi')!;

    expect(sheet.getCell('A10').value).toBe('RINGKASAN');
    expect(sheet.getCell('C11').value).toBe(3);
    expect(sheet.getCell('C12').value).toBe(100000);
    expect(sheet.getCell('C13').value).toBe(100000);
    expect(sheet.getCell('C14').value).toBe(0);
    expect(sheet.getCell('A16').value).toBe('Pengeluaran per Kategori');
    expect(sheet.getCell('A17').value).toBe('Makanan');
    expect(sheet.getCell('D17').value).toBe(1);
  });

  describe('with wallets', () => {
    const overview = {
      mode: WalletMode.BOTH,
      enabled: true,
      lines: [
        {
          wallet: Wallet.CASH,
          income: Money.fromMajor(100000),
          expense: Money.fromMajor(25000),
          balance: Money.fromMajor(75000),
          startBalance: Money.zero(),
          transferIn: Money.zero(),
          transferOut: Money.zero(),
          categories: [],
        },
        {
          wallet: Wallet.DIGITAL,
          income: Money.zero(),
          expense: Money.fromMajor(10000),
          balance: Money.fromMajor(190000),
          startBalance: Money.fromMajor(200000),
          transferIn: Money.zero(),
          transferOut: Money.zero(),
          categories: [],
        },
      ],
      total: Money.fromMajor(265000),
      transfers: [],
    };

    it('adds a Dompet column and a per-wallet summary table', async () => {
      transactions.findManyInRange.mockResolvedValue([
        tx({ description: 'kopi', wallet: null }),
        tx({ description: 'bensin', wallet: Wallet.DIGITAL }),
      ]);
      categories.findById.mockResolvedValue({ name: 'Makanan' } as never);

      const out = await service.export(
        'u1',
        SummaryPeriod.Month,
        new Date(),
        'Asia/Jakarta',
        undefined,
        overview,
      );
      const sheet = (await load(out.content)).getWorksheet('Transaksi')!;

      expect(sheet.getCell('F4').value).toBe('Dompet');
      expect(sheet.getCell('F5').value).toBe('Cash');
      expect(sheet.getCell('F6').value).toBe('Digital');

      // Summary: band 9, cards 10-13, blank, wallet table starts at 15.
      expect(sheet.getRow(15).values).toEqual([
        undefined,
        'Per Dompet',
        'Saldo Sebelumnya',
        'Pemasukan',
        'Pengeluaran',
        'Transfer',
        'Saldo',
      ]);
      // Saldo Sebelumnya + Pemasukan - Pengeluaran + Transfer = Saldo on every row.
      const ledger = (row: number) =>
        [2, 3, 4, 5, 6].map((c) => sheet.getRow(row).getCell(c).value as number);
      expect(sheet.getCell('A16').value).toBe('Cash');
      expect(ledger(16)).toEqual([0, 100000, 25000, 0, 75000]);
      expect(sheet.getCell('A17').value).toBe('Digital');
      expect(ledger(17)).toEqual([200000, 0, 10000, 0, 190000]);
      for (const row of [16, 17]) {
        const [start, inc, exp, tr, balance] = ledger(row);
        expect(start + inc - exp + tr).toBe(balance);
      }
      expect(sheet.getCell('A18').value).toBe('Total Saldo');
      expect(sheet.getCell('F18').value).toBe(265000);

      // Expense categories split per wallet, right after the wallet table.
      expect(sheet.getCell('A20').value).toBe('Pengeluaran per Kategori');
      expect(sheet.getCell('C20').value).toBe('Cash');
      expect(sheet.getCell('D20').value).toBe('Digital');
      expect(sheet.getCell('E20').value).toBe('Total');
      expect(sheet.getCell('A21').value).toBe('Makanan');
      expect(sheet.getCell('C21').value).toBe(25000);
      expect(sheet.getCell('D21').value).toBe(25000);
      expect(sheet.getCell('E21').value).toBe(50000);
    });

    it('leaves out the Saldo Sebelumnya column when nothing was carried in', async () => {
      transactions.findManyInRange.mockResolvedValue([
        tx({ description: 'kopi', wallet: null }),
        tx({ description: 'bensin', wallet: Wallet.DIGITAL }),
      ]);
      categories.findById.mockResolvedValue({ name: 'Makanan' } as never);
      const nothingCarried = {
        ...overview,
        lines: [
          { ...overview.lines[0], startBalance: Money.zero() },
          {
            ...overview.lines[1],
            startBalance: Money.zero(),
            balance: Money.fromMajor(-10000), // 0 - 10.000
          },
        ],
        total: Money.fromMajor(65000),
      };

      const out = await service.export(
        'u1',
        SummaryPeriod.Month,
        new Date(),
        'Asia/Jakarta',
        undefined,
        nothingCarried,
      );
      const sheet = (await load(out.content)).getWorksheet('Transaksi')!;

      expect(sheet.getRow(15).values).toEqual([
        undefined,
        'Per Dompet',
        'Pemasukan',
        'Pengeluaran',
        'Transfer',
        'Saldo',
      ]);
      expect(sheet.getCell('B16').value).toBe(100000); // Pemasukan (was C)
      expect(sheet.getCell('E16').value).toBe(75000); // Saldo (was F)
      expect(sheet.getCell('E18').value).toBe(65000); // Total Saldo
    });

    it('shows the net transfer per wallet in the ledger', async () => {
      transactions.findManyInRange.mockResolvedValue([tx()]);
      categories.findById.mockResolvedValue({ name: 'Makanan' } as never);
      const withTransfer = {
        ...overview,
        lines: [
          {
            ...overview.lines[0],
            startBalance: Money.zero(),
            transferIn: Money.fromMajor(30000),
            transferOut: Money.fromMajor(5000),
            balance: Money.fromMajor(100000), // 0 + 100.000 - 25.000 + 25.000
          },
          overview.lines[1],
        ],
      };

      const out = await service.export(
        'u1',
        SummaryPeriod.Month,
        new Date(),
        'Asia/Jakarta',
        undefined,
        withTransfer,
      );
      const sheet = (await load(out.content)).getWorksheet('Transaksi')!;
      // One transaction row, so the ledger header is on row 14 and Cash on row 15.
      expect(sheet.getCell('A14').value).toBe('Per Dompet');
      expect(sheet.getCell('E15').value).toBe(25000);
      expect(sheet.getCell('F15').value).toBe(100000);
    });

    it('lists the period transfers below the wallet table', async () => {
      transactions.findManyInRange.mockResolvedValue([tx()]);
      categories.findById.mockResolvedValue({ name: 'Makanan' } as never);

      const out = await service.export(
        'u1',
        SummaryPeriod.Month,
        new Date(),
        'Asia/Jakarta',
        undefined,
        {
          ...overview,
          transfers: [
            {
              id: 't1',
              userId: 'u1',
              from: Wallet.DIGITAL,
              to: Wallet.CASH,
              amount: Money.fromMajor(500000),
              note: null,
              occurredAt: new Date('2026-07-15T05:00:00.000Z'),
              messageId: null,
              deletedAt: null,
              createdAt: new Date(),
            },
          ],
        },
      );
      const sheet = (await load(out.content)).getWorksheet('Transaksi')!;

      // Wallet table 14-17 (header, cash, digital, total); transfers start after a blank row.
      expect(sheet.getCell('A19').value).toBe('Transfer Antar Dompet');
      expect(sheet.getCell('A20').value).toBe('15/07/2026');
      expect(sheet.getCell('C20').value).toBe('Digital');
      expect(sheet.getCell('D20').value).toBe('Cash');
      expect(sheet.getCell('E20').value).toBe(500000);
    });

    it('for one wallet: no Dompet column or split, but the balance table stays', async () => {
      transactions.findManyInRange.mockResolvedValue([tx()]);
      categories.findById.mockResolvedValue({ name: 'Makanan' } as never);

      const out = await service.export(
        'u1',
        SummaryPeriod.Month,
        new Date(),
        'Asia/Jakarta',
        undefined,
        {
          ...overview,
          mode: WalletMode.CASH,
          lines: [overview.lines[0]],
          total: Money.fromMajor(75000),
        },
      );
      const sheet = (await load(out.content)).getWorksheet('Transaksi')!;

      expect(sheet.getCell('F4').value).toBeNull();
      // band 8, cards 9-12, wallet table 14-16, ordinary category table 18.
      expect(sheet.getCell('A14').value).toBe('Per Dompet');
      expect(sheet.getCell('A15').value).toBe('Cash');
      expect(sheet.getCell('A18').value).toBe('Pengeluaran per Kategori');
      expect(sheet.getCell('C18').value).toBe('Jumlah');
    });

    it('omits wallet detail when wallets are not enabled', async () => {
      transactions.findManyInRange.mockResolvedValue([tx()]);
      categories.findById.mockResolvedValue({ name: 'Makanan' } as never);

      const out = await service.export(
        'u1',
        SummaryPeriod.Month,
        new Date(),
        'Asia/Jakarta',
        undefined,
        { ...overview, mode: null, enabled: false },
      );
      const sheet = (await load(out.content)).getWorksheet('Transaksi')!;
      expect(sheet.getCell('F4').value).toBeNull();
      expect(sheet.getCell('A15').value).not.toBe('Per Dompet');
    });
  });
});
