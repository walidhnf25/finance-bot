import sharp from 'sharp';

/**
 * Synthetic receipts for the OCR evaluation. They contain no personal data and are generated, not
 * stored. Each case knows what a human would read (the truth) so extraction can be scored.
 * Variants imitate real-world problems: rotation, blur, low resolution, fading, noise, cropping.
 */

export type Variant =
  | 'clean'
  | 'rotated'
  | 'blurry'
  | 'lowres'
  | 'faded'
  | 'thermal'
  | 'noisy'
  | 'cropped-total'
  | 'cropped-top';

export interface SyntheticCase {
  id: string;
  /** What the case exercises (shown in the report). */
  tag: string;
  variant: Variant;
  /** Left text, optional right-aligned text. */
  lines: Array<[string, string?]>;
  truth: {
    /** Whole rupiah; null when a human could NOT determine the total from what is visible. */
    total: number | null;
    /** `YYYY-MM-DD` when a date is clearly visible, else null. */
    date: string | null;
    merchant: string | null;
    /** Fields that are not scored for this case (for example a header that was cropped away). */
    unscored?: Array<'date' | 'merchant'>;
  };
}

const W = 760;
const LINE_H = 46;

const esc = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&#160;');

export function renderSvg(
  lines: Array<[string, string?]>,
  opts: { bg?: string; ink?: string } = {},
): string {
  const height = 60 + lines.length * LINE_H + 40;
  const bg = opts.bg ?? '#ffffff';
  const ink = opts.ink ?? '#111111';
  const body = lines
    .map(([left, right], i) => {
      const y = 70 + i * LINE_H;
      const l = `<text x="34" y="${y}" font-family="Courier New, monospace" font-size="31" fill="${ink}">${esc(left)}</text>`;
      const r = right
        ? `<text x="${W - 34}" y="${y}" text-anchor="end" font-family="Courier New, monospace" font-size="31" fill="${ink}">${esc(right)}</text>`
        : '';
      return l + r;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}"><rect width="${W}" height="${height}" fill="${bg}"/>${body}</svg>`;
}

/** Deterministic noise so a run is repeatable. */
async function noiseLayer(width: number, height: number, sigma: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#808080',
      noise: { type: 'gaussian', mean: 128, sigma },
    },
  })
    .png()
    .toBuffer();
}

export async function renderCase(c: SyntheticCase): Promise<Buffer> {
  const svg = renderSvg(c.lines, {
    bg: c.variant === 'noisy' ? '#e9e6dd' : c.variant === 'thermal' ? '#f2efe6' : '#ffffff',
    ink:
      c.variant === 'faded' || c.variant === 'noisy'
        ? '#6a6a6a'
        : c.variant === 'thermal'
          ? '#5a5a5a'
          : '#111111',
  });
  const img = sharp(Buffer.from(svg)).png();
  let buf = await img.toBuffer();
  const meta = await sharp(buf).metadata();
  const [w, h] = [meta.width ?? W, meta.height ?? 400];

  switch (c.variant) {
    case 'rotated':
      buf = await sharp(buf)
        .rotate(c.id.length % 2 === 0 ? 4 : -6, { background: '#ffffff' })
        .png()
        .toBuffer();
      break;
    case 'blurry':
      buf = await sharp(buf).blur(1.6).png().toBuffer();
      break;
    case 'lowres':
      buf = await sharp(buf)
        .resize(Math.round(w * 0.36))
        .resize(w)
        .jpeg({ quality: 40 })
        .toBuffer();
      break;
    case 'faded':
      buf = await sharp(buf).linear(0.55, 70).blur(0.6).png().toBuffer();
      break;
    case 'thermal':
      // Pale ink on slightly yellow paper, a little luminance noise, soft focus, JPEG: roughly what a
      // phone photo of a thermal receipt looks like.
      buf = await sharp(buf)
        .composite([{ input: await noiseLayer(w, h, 10), blend: 'soft-light' }])
        .greyscale()
        .blur(0.7)
        .jpeg({ quality: 60 })
        .toBuffer();
      break;
    case 'noisy':
      // A deliberately harsh case: heavy colour speckle over a dark, low-contrast background.
      buf = await sharp(buf)
        .composite([{ input: await noiseLayer(w, h, 28), blend: 'multiply' }])
        .linear(0.8, 20)
        .blur(0.5)
        .jpeg({ quality: 55 })
        .toBuffer();
      break;
    case 'cropped-total': {
      // The bottom part with the total is not in the picture.
      const keep = Math.max(120, Math.round(h * 0.52));
      buf = await sharp(buf).extract({ left: 0, top: 0, width: w, height: keep }).png().toBuffer();
      break;
    }
    case 'cropped-top': {
      const cut = Math.round(h * 0.22);
      buf = await sharp(buf)
        .extract({ left: 0, top: cut, width: w, height: h - cut })
        .png()
        .toBuffer();
      break;
    }
    default:
      break;
  }
  return buf;
}

const rp = (
  n: number,
  style: 'dot' | 'rp' | 'rpdot' | 'comma' | 'plain' | 'idr' | 'rpdec' = 'dot',
): string => {
  const dot = n.toLocaleString('de-DE'); // 875.000
  switch (style) {
    case 'rp':
      return `Rp ${dot}`;
    case 'rpdot':
      return `Rp. ${dot},-`;
    case 'comma':
      return n.toLocaleString('en-US'); // 875,000
    case 'plain':
      return String(n);
    case 'idr':
      return `IDR ${dot}`;
    case 'rpdec':
      return `Rp ${dot},00`;
    default:
      return dot;
  }
};

interface Item {
  name: string;
  qty: number;
  price: number;
}
const items = (list: Item[]): Array<[string, string]> =>
  list.flatMap((i) => [
    [i.name, ''] as [string, string],
    [`  ${i.qty} x ${rp(i.price)}`, rp(i.qty * i.price)] as [string, string],
  ]);
const sum = (list: Item[]): number => list.reduce((a, i) => a + i.qty * i.price, 0);

const ELEC: Item[] = [
  { name: 'PPG', qty: 1, price: 500000 },
  { name: 'Pulse Sensor', qty: 1, price: 150000 },
  { name: 'Pointer', qty: 1, price: 225000 },
];
const MART: Item[] = [
  { name: 'Aqua 600ml', qty: 2, price: 4000 },
  { name: 'Roti Tawar Sari', qty: 1, price: 16500 },
  { name: 'Susu UHT 1L', qty: 1, price: 19800 },
  { name: 'Mie Instan Goreng', qty: 5, price: 3200 },
];
const FOOD: Item[] = [
  { name: 'Nasi Goreng Spesial', qty: 2, price: 28000 },
  { name: 'Es Teh Manis', qty: 2, price: 6000 },
  { name: 'Ayam Bakar', qty: 1, price: 35000 },
];

function withTotalLabel(
  label: string,
  amountText: string,
  layout: 'same' | 'next' | 'dots' = 'same',
): Array<[string, string?]> {
  if (layout === 'next') return [[label], ['', amountText]];
  if (layout === 'dots')
    return [[`${label} ${'.'.repeat(Math.max(2, 22 - label.length))}`, amountText]];
  return [[label, amountText]];
}

/** Cases that a clean image should get right; variants then degrade the same content. */
function baseCases(): Array<Omit<SyntheticCase, 'variant' | 'id'> & { key: string }> {
  const out: Array<Omit<SyntheticCase, 'variant' | 'id'> & { key: string }> = [];
  const add = (
    key: string,
    tag: string,
    lines: Array<[string, string?]>,
    truth: SyntheticCase['truth'],
  ): void => {
    out.push({ key, tag, lines, truth });
  };

  add(
    'elec-longdate',
    'Indonesian long date, "Total Belanja", change line larger than total',
    [
      ['SURYA ELEKTRONIK'],
      ['Jl. Veteran Utara No.248B'],
      ['Telp. 0411 3628529'],
      ['Sabtu, 16 November 2019'],
      ['13:56:30'],
      ...items(ELEC),
      ...withTotalLabel('Total Belanja', rp(sum(ELEC), 'rpdot')),
      ['Tunai', 'RP. 900.000'],
      ['Kembali', 'Rp. 25.000'],
      ['Terima Kasih'],
    ],
    { total: sum(ELEC), date: '2019-11-16', merchant: 'SURYA ELEKTRONIK' },
  );

  add(
    'mart-slash',
    'dd/mm/yyyy, TOTAL, tax and discount lines',
    [
      ['INDOMARET CIPUTAT'],
      ['12/10/2026 10:15'],
      ...items(MART),
      ['SUBTOTAL', rp(sum(MART))],
      ['DISKON', '-5.000'],
      ['PPN 11%', rp(Math.round((sum(MART) - 5000) * 0.11))],
      ['TOTAL', rp(sum(MART) - 5000 + Math.round((sum(MART) - 5000) * 0.11))],
      ['TUNAI', '200.000'],
      ['KEMBALI', '0'],
    ],
    {
      total: sum(MART) - 5000 + Math.round((sum(MART) - 5000) * 0.11),
      date: '2026-10-12',
      merchant: 'INDOMARET CIPUTAT',
    },
  );

  add(
    'food-grand',
    '"GRAND TOTAL" after service and tax, month-name date',
    [
      ['WARUNG MAKAN BU SITI'],
      ['12 Okt 2026  19:42'],
      ...items(FOOD),
      ['Subtotal', rp(sum(FOOD))],
      ['Service 5%', rp(Math.round(sum(FOOD) * 0.05))],
      ['PB1 10%', rp(Math.round(sum(FOOD) * 0.1))],
      ['GRAND TOTAL', rp(Math.round(sum(FOOD) * 1.15))],
      ['Cash', '300.000'],
    ],
    { total: Math.round(sum(FOOD) * 1.15), date: '2026-10-12', merchant: 'WARUNG MAKAN BU SITI' },
  );

  add(
    'next-line',
    'label on one line, amount on the next',
    [
      ['APOTEK SEHAT SENTOSA'],
      ['03-08-26'],
      ['Paracetamol 500mg', '12.000'],
      ['Vitamin C', '38.500'],
      ['TOTAL BAYAR'],
      ['', rp(50500, 'rp')],
      ['Tunai', '100.000'],
      ['Kembali', '49.500'],
    ],
    { total: 50500, date: '2026-08-03', merchant: 'APOTEK SEHAT SENTOSA' },
  );

  add(
    'dots',
    'dotted leaders, "Jumlah"',
    [
      ['TOKO BANGUNAN MAJU JAYA'],
      ['2026-09-30 08:11'],
      ['Semen 40kg', '65.000'],
      ['Paku 5cm 1kg', '22.000'],
      ...withTotalLabel('Jumlah', '87.000', 'dots'),
      ['Bayar', '100.000'],
    ],
    { total: 87000, date: '2026-09-30', merchant: 'TOKO BANGUNAN MAJU JAYA' },
  );

  add(
    'plain-number',
    'amount without separators',
    [
      ['BENGKEL MOTOR SEJAHTERA'],
      ['15.09.2026'],
      ['Ganti oli', '55000'],
      ['Servis ringan', '120000'],
      ['Total', '175000'],
      ['Tunai', '200000'],
    ],
    { total: 175000, date: '2026-09-15', merchant: 'BENGKEL MOTOR SEJAHTERA' },
  );

  add(
    'comma-style',
    'thousands with commas',
    [
      ['KOPI KENANGAN HOLDINGS LTD'],
      ['20/07/2026'],
      ['Latte', '28,000'],
      ['Croissant', '24,000'],
      ['Total', '52,000'],
      ['Card', '52,000'],
    ],
    { total: 52000, date: '2026-07-20', merchant: 'KOPI KENANGAN HOLDINGS LTD' },
  );

  add(
    'idr-prefix',
    '"IDR" currency and decimals ",00"',
    [
      ['GRAMEDIA PONDOK INDAH'],
      ['05/01/2026 15:20'],
      ['Buku Tulis A5', 'IDR 18.500,00'],
      ['Pulpen Gel', 'IDR 12.000,00'],
      ['Total Tagihan', rp(30500, 'rpdec')],
      ['Debit BCA', rp(30500, 'rpdec')],
    ],
    { total: 30500, date: '2026-01-05', merchant: 'GRAMEDIA PONDOK INDAH' },
  );

  add(
    'total-item-qty',
    '"Total Item/Qty" lines must not be read as the total',
    [
      ['ALFAMART JL MAWAR'],
      ['31/12/2026 21:05'],
      ['Telur 1kg', '31.000'],
      ['Minyak 2L', '38.500'],
      ['Gula 1kg', '17.000'],
      ['Total Item', '3'],
      ['Total Qty', '3'],
      ['TOTAL', '86.500'],
      ['TUNAI', '100.000'],
    ],
    { total: 86500, date: '2026-12-31', merchant: 'ALFAMART JL MAWAR' },
  );

  add(
    'netto',
    '"Netto" after discount',
    [
      ['BUTIK ANGGUN'],
      ['Minggu, 6 September 2026'],
      ['Blouse', '250.000'],
      ['Diskon 20%', '-50.000'],
      ['Netto', '200.000'],
      ['Tunai', '200.000'],
    ],
    { total: 200000, date: '2026-09-06', merchant: 'BUTIK ANGGUN' },
  );

  add(
    'big-total',
    'total in millions, change much smaller',
    [
      ['MEGA ELEKTRONIK CENTER'],
      ['02/10/2026'],
      ['TV LED 43"', '3.499.000'],
      ['Kabel HDMI', '85.000'],
      ['TOTAL', '3.584.000'],
      ['TUNAI', '3.600.000'],
      ['KEMBALI', '16.000'],
    ],
    { total: 3584000, date: '2026-10-02', merchant: 'MEGA ELEKTRONIK CENTER' },
  );

  add(
    'long-merchant',
    'very long merchant name',
    [
      ['PT SUMBER ALFARIA TRIJAYA TBK CABANG'],
      ['TANGERANG SELATAN'],
      ['09/11/2026 18:30'],
      ['Sabun Mandi', '9.800'],
      ['Shampoo', '22.500'],
      ['TOTAL', '32.300'],
    ],
    { total: 32300, date: '2026-11-09', merchant: 'PT SUMBER ALFARIA TRIJAYA TBK CABANG' },
  );

  add(
    'no-date',
    'no date printed',
    [['WARUNG PECEL LELE'], ['Pecel Lele', '18.000'], ['Es Jeruk', '5.000'], ['TOTAL', '23.000']],
    { total: 23000, date: null, merchant: 'WARUNG PECEL LELE' },
  );

  add(
    'no-label',
    'NO total label: a human sees a single bottom amount but it is ambiguous',
    [
      ['KIOS FOTOKOPI'],
      ['10/10/2026'],
      ['Fotokopi 40 lbr', '8.000'],
      ['Jilid', '7.000'],
      ['', '15.000'],
    ],
    { total: null, date: '2026-10-10', merchant: 'KIOS FOTOKOPI' },
  );

  add(
    'two-totals',
    'subtotal and total both labelled with "total"',
    [
      ['RESTO NUSANTARA'],
      ['14/10/2026 12:00'],
      ['Sate Ayam', '40.000'],
      ['Sub Total', '40.000'],
      ['Total Service', '2.000'],
      ['Total Pajak', '4.000'],
      ['Total Bayar', '46.000'],
      ['Tunai', '50.000'],
    ],
    { total: 46000, date: '2026-10-14', merchant: 'RESTO NUSANTARA' },
  );

  return out;
}

const VARIANT_PLAN: Variant[] = [
  'clean',
  'rotated',
  'blurry',
  'lowres',
  'faded',
  'thermal',
  'noisy',
];

/** ~16 base receipts: all clean, plus every one under 2-3 degradations. Deterministic. */
export function buildCases(): SyntheticCase[] {
  const cases: SyntheticCase[] = [];
  baseCases().forEach((b, i) => {
    // Every receipt: clean, two degradations, and once as a thermal-paper photo; every other one
    // also in the harsh noisy form.
    const variants: Variant[] = [
      'clean',
      VARIANT_PLAN[1 + (i % 4)],
      VARIANT_PLAN[1 + ((i + 2) % 4)],
      'thermal',
    ];
    if (i % 2 === 0) variants.push('noisy');
    // The cropped variants are added for a few receipts only (they are expected to lose information).
    if (i % 4 === 0) variants.push('cropped-total');
    if (i % 5 === 1) variants.push('cropped-top');
    for (const variant of variants) {
      const truth = { ...b.truth };
      if (variant === 'cropped-total') {
        truth.total = null; // the total is not in the picture
        truth.unscored = ['date', 'merchant'];
      }
      if (variant === 'cropped-top') truth.unscored = ['date', 'merchant']; // the header is cut off
      cases.push({ id: `${b.key}:${variant}`, tag: b.tag, variant, lines: b.lines, truth });
    }
  });
  return cases;
}
