import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

import {
  ImageLimits,
  InvalidImageError,
  PreparedImage,
  ReceiptImageProcessor,
} from '../domain/receipt-ports';

// Re-exported so existing imports keep working; the definitions live in the domain ports.
export { InvalidImageError };
export type { ImageLimits, PreparedImage };

/** Longest side after preprocessing: large enough for OCR, small enough to bound memory and time. */
const MAX_SIDE = 2200;

type Format = 'jpeg' | 'png' | 'webp';

/** The claimed MIME type / file name is never trusted: the leading bytes decide. */
export function sniffFormat(bytes: Buffer): Format | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/**
 * Validates and normalises an untrusted image: size cap, magic-byte format check, pixel cap
 * (decompression-bomb guard, enforced by sharp BEFORE decoding), EXIF rotation applied, then
 * everything else in the metadata (GPS, device, timestamps) dropped by re-encoding.
 */
export async function prepareImage(bytes: Buffer, limits: ImageLimits): Promise<PreparedImage> {
  if (bytes.length === 0) throw new InvalidImageError('not_an_image');
  if (bytes.length > limits.maxBytes) throw new InvalidImageError('too_large');
  if (!sniffFormat(bytes)) throw new InvalidImageError('unsupported');

  try {
    const base = () =>
      sharp(bytes, { limitInputPixels: limits.maxPixels, failOn: 'error', sequentialRead: true });
    const meta = await base().metadata();
    if (!meta.width || !meta.height) throw new InvalidImageError('corrupt');
    if (meta.width * meta.height > limits.maxPixels) throw new InvalidImageError('too_many_pixels');

    const { data, info } = await base()
      .rotate() // honour EXIF orientation, then the metadata is discarded below
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .greyscale()
      .normalise()
      .png()
      .toBuffer({ resolveWithObject: true });

    return {
      png: data,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      width: info.width,
      height: info.height,
    };
  } catch (err) {
    if (err instanceof InvalidImageError) throw err;
    const message = err instanceof Error ? err.message : '';
    // sharp reports an exceeded pixel limit with this wording.
    if (/pixel limit/i.test(message)) throw new InvalidImageError('too_many_pixels');
    throw new InvalidImageError('corrupt');
  }
}

/**
 * A second, stronger preprocessing used only when the first OCR pass found no usable total:
 * upscale small text, remove speckle, sharpen, stretch contrast. Input is the already normalised
 * greyscale PNG from {@link prepareImage}.
 */
export async function enhanceForOcr(png: Buffer): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const width = meta.width ?? 800;
  const target = Math.min(2400, Math.max(width, 1700));
  return sharp(png)
    .resize({ width: target, kernel: 'lanczos3', withoutEnlargement: false })
    .median(3)
    .normalise()
    .sharpen({ sigma: 1.2 })
    .png()
    .toBuffer();
}

/** The sharp implementation of the {@link ReceiptImageProcessor} port. */
@Injectable()
export class SharpImageProcessor extends ReceiptImageProcessor {
  prepare(bytes: Buffer, limits: ImageLimits): Promise<PreparedImage> {
    return prepareImage(bytes, limits);
  }
  enhanceForOcr(png: Buffer): Promise<Buffer> {
    return enhanceForOcr(png);
  }
}
