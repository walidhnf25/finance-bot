/**
 * Lexicons for the rule-based parser. Kept separate so they are easy to extend
 * and review. All entries are normalized (lowercase, no diacritics).
 */

export const HELP_WORDS = ['help', 'bantuan', 'menu', 'panduan', 'mulai', 'start', 'cara pakai'];

export const GREETING_WORDS = [
  'hai',
  'hi',
  'halo',
  'hallo',
  'hello',
  'hey',
  'assalamualaikum',
  'test',
  'tes',
  'ping',
];

export const DELETE_WORDS = ['hapus', 'batal', 'batalkan', 'batalin', 'cancel', 'delete'];

export const EDIT_WORDS = ['edit', 'ubah', 'ganti', 'koreksi', 'rubah', 'revisi'];

export const SUMMARY_WORDS = [
  'ringkasan',
  'rekap',
  'rekapan',
  'laporan',
  'summary',
  'total',
  'riwayat',
  'history',
];

export const EXPORT_WORDS = ['export', 'ekspor', 'unduh', 'download', 'csv'];

/** Words naming the cash wallet. */
export const CASH_WALLET_WORDS = ['cash', 'tunai', 'kas'];

/** Words naming the digital wallet (bank transfer, QRIS, e-wallets, cards). */
export const DIGITAL_WALLET_WORDS = [
  'digital',
  'transfer',
  'tf',
  'qris',
  'gopay',
  'ovo',
  'shopeepay',
  'linkaja',
  'ewallet',
  'debit',
  'kredit',
  'bca',
  'bri',
  'bni',
  'mandiri',
  'jago',
  'seabank',
];

/** Verbs for moving money between wallets ("pindah 500rb dari digital ke cash"). */
export const TRANSFER_WORDS = ['pindah', 'pindahkan', 'pindahin', 'mutasi'];

/** "atur dompet" starts the wallet setup question. */
export const WALLET_SETUP_WORDS = ['atur', 'setup', 'setting', 'pengaturan', 'pilih'];

/** Words meaning "both wallets" in an answer to the setup question. */
export const BOTH_WALLET_WORDS = ['keduanya', 'kedua', 'dua', 'semua', 'both'];

export const BALANCE_WORDS = ['saldo'];

export const DEFAULT_WORDS = ['default', 'utama', 'standar'];

export const BUDGET_WORDS = ['budget', 'anggaran', 'batasi', 'batas'];

/** Words indicating money coming IN. */
export const INCOME_WORDS = [
  'gaji',
  'gajian',
  'salary',
  'bonus',
  'thr',
  'insentif',
  'komisi',
  'untung',
  'profit',
  'omzet',
  'omset',
  'pemasukan',
  'pendapatan',
  'honor',
  'fee',
  'dividen',
  'bunga',
  'refund',
  'cashback',
  'hadiah',
  'jualan',
  'penjualan',
  'upah',
  'dapat',
  'terima',
];

/** Verbs indicating money going OUT (also used as a "this is a transaction" cue). */
export const EXPENSE_VERBS = [
  'beli',
  'bayar',
  'jajan',
  'makan',
  'minum',
  'isi',
  'belanja',
  'top up',
  'topup',
  'langganan',
  'sewa',
  'traktir',
  'nonton',
  'ngopi',
  'pesan',
  'order',
];

/**
 * Filler words removed when building a transaction description. Pure verbs and
 * prepositions only — never category nouns.
 */
export const STOPWORDS = new Set([
  'beli',
  'bayar',
  'buat',
  'untuk',
  'di',
  'ke',
  'dari',
  'harga',
  'seharga',
  'sebesar',
  'abis',
  'habis',
  'sama',
  'pake',
  'pakai',
  'sudah',
  'udah',
  'baru',
  'aja',
  'saja',
  'dong',
  'ya',
  'nih',
  'isi',
  'pesan',
  'order',
  'senilai',
  'sejumlah',
  'total',
]);
