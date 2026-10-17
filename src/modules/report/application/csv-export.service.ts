import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { CategoryRepository } from 'src/modules/category/domain/category.repository';
import { DateRangeSpec, SummaryPeriod } from 'src/modules/parser/domain/parsed-intent';
import { TransactionRepository } from 'src/modules/transaction/domain/transaction.repository';
import { WalletLine, WalletOverview } from 'src/modules/wallet/application/wallet.service';
import { TransferEntity } from 'src/modules/wallet/domain/transfer.entity';
import { DEFAULT_WALLET, TransactionType, Wallet } from 'src/shared/domain/enums';
import { formatDate } from 'src/shared/utils/date.util';
import { Money } from 'src/shared/utils/money';
import { customRangeInfo, resolvePeriod } from './period';

export interface CsvExport {
  content: Buffer;
  filename: string;
  mimeType: string;
  rowCount: number;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const UNCATEGORIZED = 'Tanpa Kategori';
const WALLET_NAME: Record<Wallet, string> = {
  [Wallet.CASH]: 'Cash',
  [Wallet.DIGITAL]: 'Digital',
};
const RUPIAH_FORMAT = '"Rp"#,##0;[Red]-"Rp"#,##0';
const TABLE_HEADER_ROW = 4;

const COLOR = {
  primary: 'FF1F4E79',
  headerText: 'FFFFFFFF',
  stripe: 'FFF2F7FB',
  border: 'FFD0D7DE',
  income: 'FF1E7B34',
  incomeBg: 'FFE6F4EA',
  expense: 'FFB3261E',
  expenseBg: 'FFFCE8E6',
  muted: 'FF5F6B76',
} as const;

const thin = { style: 'thin', color: { argb: COLOR.border } } as const;
const BORDER: Partial<ExcelJS.Borders> = { top: thin, left: thin, bottom: thin, right: thin };

function fill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function toRupiah(m: Money): number {
  return m.toNumber();
}

function styleHeader(row: ExcelJS.Row, argb: string, cols: number): void {
  row.height = 22;
  for (let c = 1; c <= cols; c++) {
    const cell = row.getCell(c);
    cell.font = { bold: true, color: { argb: COLOR.headerText } };
    cell.fill = fill(argb);
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = BORDER;
  }
}

/** Full-width coloured band used as a section title. */
function addBand(sheet: ExcelJS.Worksheet, rowNum: number, text: string, lastCol: string): void {
  sheet.mergeCells(`A${rowNum}:${lastCol}${rowNum}`);
  const row = sheet.getRow(rowNum);
  row.height = 24;
  const cell = row.getCell(1);
  cell.value = text;
  cell.font = { bold: true, size: 13, color: { argb: COLOR.headerText } };
  cell.fill = fill(COLOR.primary);
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
}

/** Category breakdown table, largest first. Returns the next free row number. */
function addBreakdown(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  title: string,
  totals: Map<string, Money>,
  grand: Money,
  accent: string,
): number {
  if (totals.size === 0) return startRow;
  sheet.mergeCells(`A${startRow}:B${startRow}`);
  const header = sheet.getRow(startRow);
  header.getCell(1).value = title;
  header.getCell(3).value = 'Jumlah';
  header.getCell(4).value = 'Persentase';
  styleHeader(header, accent, 4);
  header.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  const entries = [...totals.entries()].sort((a, b) => b[1].compareTo(a[1]));
  let r = startRow + 1;
  entries.forEach(([name, sum], i) => {
    const share = grand.isZero() ? 0 : Number((sum.minorUnits * 10000n) / grand.minorUnits) / 10000;
    sheet.mergeCells(`A${r}:B${r}`);
    const row = sheet.getRow(r);
    row.getCell(1).value = name;
    row.getCell(1).alignment = { indent: 1 };
    row.getCell(3).value = toRupiah(sum);
    row.getCell(3).numFmt = RUPIAH_FORMAT;
    row.getCell(4).value = share;
    row.getCell(4).numFmt = '0.0%';
    row.getCell(4).alignment = { horizontal: 'right' };
    for (let c = 1; c <= 4; c++) {
      row.getCell(c).border = BORDER;
      if (i % 2 === 1) row.getCell(c).fill = fill(COLOR.stripe);
    }
    r++;
  });
  return r + 1;
}

/** Transfers inside the period: date, from, to, amount. Returns the next free row. */
function addTransferTable(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  transfers: TransferEntity[],
  tz: string,
): number {
  sheet.mergeCells(`A${startRow}:B${startRow}`);
  const header = sheet.getRow(startRow);
  header.getCell(1).value = 'Transfer Antar Dompet';
  header.getCell(3).value = 'Dari';
  header.getCell(4).value = 'Ke';
  header.getCell(5).value = 'Jumlah';
  styleHeader(header, COLOR.primary, 5);
  header.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  let r = startRow + 1;
  transfers.forEach((t, i) => {
    sheet.mergeCells(`A${r}:B${r}`);
    const row = sheet.getRow(r);
    row.getCell(1).value = formatDate(t.occurredAt, tz);
    row.getCell(1).alignment = { indent: 1 };
    row.getCell(3).value = WALLET_NAME[t.from];
    row.getCell(4).value = WALLET_NAME[t.to];
    row.getCell(3).alignment = { horizontal: 'center' };
    row.getCell(4).alignment = { horizontal: 'center' };
    row.getCell(5).value = toRupiah(t.amount);
    row.getCell(5).numFmt = RUPIAH_FORMAT;
    for (let c = 1; c <= 5; c++) {
      row.getCell(c).border = BORDER;
      if (i % 2 === 1) row.getCell(c).fill = fill(COLOR.stripe);
    }
    r++;
  });
  return r + 1;
}

type WalletSplit = Record<Wallet, Money>;

/** Expense per category with a Cash / Digital / Total column. Returns the next free row. */
function addWalletBreakdown(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  title: string,
  totals: Map<string, WalletSplit>,
  accent: string,
): number {
  if (totals.size === 0) return startRow;
  sheet.mergeCells(`A${startRow}:B${startRow}`);
  const header = sheet.getRow(startRow);
  header.getCell(1).value = title;
  header.getCell(3).value = 'Cash';
  header.getCell(4).value = 'Digital';
  header.getCell(5).value = 'Total';
  styleHeader(header, accent, 5);
  header.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  const sum = (s: WalletSplit): Money => s[Wallet.CASH].add(s[Wallet.DIGITAL]);
  const entries = [...totals.entries()].sort((a, b) => sum(b[1]).compareTo(sum(a[1])));
  let r = startRow + 1;
  entries.forEach(([name, split], i) => {
    sheet.mergeCells(`A${r}:B${r}`);
    const row = sheet.getRow(r);
    row.getCell(1).value = name;
    row.getCell(1).alignment = { indent: 1 };
    row.getCell(3).value = toRupiah(split[Wallet.CASH]);
    row.getCell(4).value = toRupiah(split[Wallet.DIGITAL]);
    row.getCell(5).value = toRupiah(sum(split));
    row.getCell(5).font = { bold: true };
    for (let c = 3; c <= 5; c++) row.getCell(c).numFmt = RUPIAH_FORMAT;
    for (let c = 1; c <= 5; c++) {
      row.getCell(c).border = BORDER;
      if (i % 2 === 1) row.getCell(c).fill = fill(COLOR.stripe);
    }
    r++;
  });
  return r + 1;
}

/**
 * Two-wallet balance ledger: Saldo Sebelumnya + Pemasukan - Pengeluaran + Transfer = Saldo,
 * so every wallet balance can be traced. Uses all six sheet columns.
 */
function addWalletLedger(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  overview: WalletOverview,
): number {
  // "Saldo Sebelumnya" only appears when some wallet carries a balance in from before
  // the report window; otherwise it is a column of zeros.
  const showStart = overview.lines.some((l) => !l.startBalance.isZero());
  const columns: Array<{ header: string; value: (l: WalletLine) => number }> = [
    ...(showStart
      ? [{ header: 'Saldo Sebelumnya', value: (l: WalletLine) => toRupiah(l.startBalance) }]
      : []),
    { header: 'Pemasukan', value: (l) => toRupiah(l.income) },
    { header: 'Pengeluaran', value: (l) => toRupiah(l.expense) },
    { header: 'Transfer', value: (l) => toRupiah(l.transferIn.subtract(l.transferOut)) },
    { header: 'Saldo', value: (l) => toRupiah(l.balance) },
  ];
  const last = columns.length + 1; // column A holds the wallet name

  const header = sheet.getRow(startRow);
  header.values = ['Per Dompet', ...columns.map((c) => c.header)];
  styleHeader(header, COLOR.primary, last);

  let r = startRow + 1;
  overview.lines.forEach((line, i) => {
    const row = sheet.getRow(r);
    row.getCell(1).value = WALLET_NAME[line.wallet];
    columns.forEach((c, j) => {
      row.getCell(j + 2).value = c.value(line);
      row.getCell(j + 2).numFmt = RUPIAH_FORMAT;
    });
    row.getCell(last).font = { bold: true };
    for (let c = 1; c <= last; c++) {
      row.getCell(c).border = BORDER;
      if (i % 2 === 1) row.getCell(c).fill = fill(COLOR.stripe);
    }
    r++;
  });

  const total = sheet.getRow(r);
  total.getCell(1).value = 'Total Saldo';
  total.getCell(last).value = toRupiah(overview.total);
  total.getCell(last).numFmt = RUPIAH_FORMAT;
  for (let c = 1; c <= last; c++) {
    total.getCell(c).font = { bold: true };
    total.getCell(c).fill = fill(COLOR.stripe);
    total.getCell(c).border = BORDER;
  }
  return r + 2;
}

/** One-wallet table: money in/out over the period and the balance. */
function addWalletTable(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  overview: WalletOverview,
): number {
  sheet.mergeCells(`A${startRow}:B${startRow}`);
  const header = sheet.getRow(startRow);
  header.getCell(1).value = 'Per Dompet';
  header.getCell(3).value = 'Pemasukan';
  header.getCell(4).value = 'Pengeluaran';
  header.getCell(5).value = 'Saldo Saat Ini';
  styleHeader(header, COLOR.primary, 5);
  header.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  let r = startRow + 1;
  overview.lines.forEach((line, i) => {
    sheet.mergeCells(`A${r}:B${r}`);
    const row = sheet.getRow(r);
    row.getCell(1).value = WALLET_NAME[line.wallet];
    row.getCell(1).alignment = { indent: 1 };
    row.getCell(3).value = toRupiah(line.income);
    row.getCell(4).value = toRupiah(line.expense);
    row.getCell(5).value = toRupiah(line.balance);
    for (let c = 3; c <= 5; c++) row.getCell(c).numFmt = RUPIAH_FORMAT;
    row.getCell(5).font = { bold: true };
    for (let c = 1; c <= 5; c++) {
      row.getCell(c).border = BORDER;
      if (i % 2 === 1) row.getCell(c).fill = fill(COLOR.stripe);
    }
    r++;
  });

  sheet.mergeCells(`A${r}:B${r}`);
  const total = sheet.getRow(r);
  total.getCell(1).value = 'Total Saldo';
  total.getCell(5).value = toRupiah(overview.total);
  total.getCell(5).numFmt = RUPIAH_FORMAT;
  for (let c = 1; c <= 5; c++) {
    total.getCell(c).font = { bold: true };
    total.getCell(c).fill = fill(COLOR.stripe);
    total.getCell(c).border = BORDER;
  }
  total.getCell(1).alignment = { indent: 1 };
  return r + 2;
}

/**
 * Exports a user's transactions for a period to a formatted Excel workbook (.xlsx):
 * a single "Transaksi" sheet with the date-sorted transaction table followed by a
 * summary (totals + per-category breakdown) for the exported range.
 */
@Injectable()
export class CsvExportService {
  constructor(
    private readonly transactions: TransactionRepository,
    private readonly categories: CategoryRepository,
  ) {}

  async export(
    userId: string,
    period: SummaryPeriod,
    now: Date,
    tz: string,
    customRange?: DateRangeSpec,
    wallets?: WalletOverview,
  ): Promise<CsvExport> {
    const { range, slug, label } = customRange
      ? customRangeInfo(customRange, tz)
      : resolvePeriod(period, now, tz);
    const rows = [...(await this.transactions.findManyInRange(userId, range))].sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );

    const categoryNames = new Map<string, string>();
    for (const id of new Set(rows.map((t) => t.categoryId).filter((id): id is string => !!id))) {
      categoryNames.set(id, (await this.categories.findById(id, userId))?.name ?? '');
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Finance Bot';
    wb.created = now;

    const sheet = wb.addWorksheet('Transaksi', {
      views: [{ state: 'frozen', ySplit: TABLE_HEADER_ROW }],
    });
    // The Dompet column and per-wallet category split only make sense with two wallets.
    const showWallets = wallets?.enabled === true && wallets.lines.length > 1;
    const colCount = showWallets ? 6 : 5;
    const lastCol = showWallets ? 'F' : 'E';
    sheet.columns = [
      { width: 13 },
      { width: 14 },
      { width: 18 },
      { width: 34 },
      { width: 20 },
      ...(showWallets ? [{ width: 16 }] : []),
    ];

    // ---- Title ----
    sheet.mergeCells(`A1:${lastCol}1`);
    sheet.mergeCells(`A2:${lastCol}2`);
    const title = sheet.getCell('A1');
    title.value = 'Laporan Keuangan';
    title.font = { bold: true, size: 16, color: { argb: COLOR.primary } };
    title.alignment = { vertical: 'middle' };
    sheet.getRow(1).height = 26;
    const subtitle = sheet.getCell('A2');
    subtitle.value = `Periode: ${label}`;
    subtitle.font = { italic: true, color: { argb: COLOR.muted } };

    // ---- Transaction table ----
    const header = sheet.getRow(TABLE_HEADER_ROW);
    header.values = [
      'Tanggal',
      'Tipe',
      'Jumlah',
      'Deskripsi',
      'Kategori',
      ...(showWallets ? ['Dompet'] : []),
    ];
    styleHeader(header, COLOR.primary, colCount);

    let income = Money.zero();
    let expense = Money.zero();
    const incomeByCat = new Map<string, Money>();
    const expenseByCat = new Map<string, Money>();
    const expenseByCatWallet = new Map<string, WalletSplit>();

    rows.forEach((t, i) => {
      const category = (t.categoryId && categoryNames.get(t.categoryId)) || '';
      const isIncome = t.type === TransactionType.INCOME;
      const row = sheet.getRow(TABLE_HEADER_ROW + 1 + i);
      row.values = [
        formatDate(t.occurredAt, tz),
        isIncome ? 'Pemasukan' : 'Pengeluaran',
        toRupiah(t.amount),
        t.description,
        category || UNCATEGORIZED,
        ...(showWallets ? [WALLET_NAME[t.wallet ?? DEFAULT_WALLET]] : []),
      ];
      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(2).alignment = { horizontal: 'center' };
      row.getCell(2).font = {
        bold: true,
        color: { argb: isIncome ? COLOR.income : COLOR.expense },
      };
      row.getCell(3).numFmt = RUPIAH_FORMAT;
      row.eachCell((c) => {
        c.border = BORDER;
        if (i % 2 === 1) c.fill = fill(COLOR.stripe);
      });

      const bucket = isIncome ? incomeByCat : expenseByCat;
      const key = category || UNCATEGORIZED;
      bucket.set(key, (bucket.get(key) ?? Money.zero()).add(t.amount));
      if (isIncome) income = income.add(t.amount);
      else {
        expense = expense.add(t.amount);
        const split = expenseByCatWallet.get(key) ?? {
          [Wallet.CASH]: Money.zero(),
          [Wallet.DIGITAL]: Money.zero(),
        };
        const w = t.wallet ?? DEFAULT_WALLET;
        split[w] = split[w].add(t.amount);
        expenseByCatWallet.set(key, split);
      }
    });

    if (rows.length === 0) {
      return this.finish(wb, slug, 0);
    }
    const lastRow = TABLE_HEADER_ROW + rows.length;
    sheet.autoFilter = { from: `A${TABLE_HEADER_ROW}`, to: `${lastCol}${lastRow}` };

    // ---- Summary (below the table) ----
    const bandRow = lastRow + 3;
    addBand(sheet, bandRow, 'RINGKASAN', lastCol);

    const balance = income.subtract(expense);
    const cards: [string, string | number, string, string, string?][] = [
      ['Jumlah Transaksi', rows.length, COLOR.primary, COLOR.stripe],
      ['Total Pemasukan', toRupiah(income), COLOR.income, COLOR.incomeBg, RUPIAH_FORMAT],
      ['Total Pengeluaran', toRupiah(expense), COLOR.expense, COLOR.expenseBg, RUPIAH_FORMAT],
      [
        'Selisih (Pemasukan - Pengeluaran)',
        toRupiah(balance),
        balance.isNegative() ? COLOR.expense : COLOR.income,
        balance.isNegative() ? COLOR.expenseBg : COLOR.incomeBg,
        RUPIAH_FORMAT,
      ],
    ];
    cards.forEach(([name, value, color, bg, fmt], i) => {
      const r = bandRow + 1 + i;
      sheet.mergeCells(`A${r}:B${r}`);
      const row = sheet.getRow(r);
      row.height = 22;
      row.getCell(1).value = name;
      row.getCell(1).font = { bold: true };
      row.getCell(1).alignment = { vertical: 'middle', indent: 1 };
      row.getCell(3).value = value;
      row.getCell(3).font = { bold: true, size: 12, color: { argb: color } };
      row.getCell(3).alignment = { vertical: 'middle', horizontal: 'right' };
      if (fmt) row.getCell(3).numFmt = fmt;
      for (let c = 1; c <= 3; c++) {
        row.getCell(c).fill = fill(bg);
        row.getCell(c).border = BORDER;
      }
    });

    let next = bandRow + cards.length + 2;
    if (wallets?.enabled) {
      next = showWallets
        ? addWalletLedger(sheet, next, wallets)
        : addWalletTable(sheet, next, wallets);
      if (wallets.transfers.length > 0) {
        next = addTransferTable(sheet, next, wallets.transfers, tz);
      }
    }
    next = showWallets
      ? addWalletBreakdown(
          sheet,
          next,
          'Pengeluaran per Kategori',
          expenseByCatWallet,
          COLOR.expense,
        )
      : addBreakdown(sheet, next, 'Pengeluaran per Kategori', expenseByCat, expense, COLOR.expense);
    addBreakdown(sheet, next, 'Pemasukan per Kategori', incomeByCat, income, COLOR.income);

    return this.finish(wb, slug, rows.length);
  }

  private async finish(wb: ExcelJS.Workbook, slug: string, rowCount: number): Promise<CsvExport> {
    return {
      content: Buffer.from(await wb.xlsx.writeBuffer()),
      filename: `transaksi-${slug}.xlsx`,
      mimeType: XLSX_MIME,
      rowCount,
    };
  }
}
