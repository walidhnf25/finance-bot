import sharp from 'sharp';
import { InvalidImageError, prepareImage, sniffFormat } from './image-processor';

const LIMITS = { maxBytes: 1_000_000, maxPixels: 4_000_000 };

const solid = (width: number, height: number, format: 'png' | 'jpeg' | 'webp' = 'png') =>
  sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    [format]()
    .toBuffer();

describe('prepareImage', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('accepts and normalises a %s image', async (format) => {
    const img = await prepareImage(await solid(300, 200, format), LIMITS);
    expect(sniffFormat(img.png)).toBe('png');
    expect(img.width).toBe(300);
    expect(img.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the original bytes: identical photos collide, different ones do not', async () => {
    const a = await solid(100, 100);
    const b = await solid(101, 100);
    expect((await prepareImage(a, LIMITS)).sha256).toBe(
      (await prepareImage(Buffer.from(a), LIMITS)).sha256,
    );
    expect((await prepareImage(a, LIMITS)).sha256).not.toBe((await prepareImage(b, LIMITS)).sha256);
  });

  it('shrinks very large images and applies EXIF rotation', async () => {
    const wide = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: '#fff' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 }) // stored sideways: must be rotated upright
      .toBuffer();
    const img = await prepareImage(wide, { maxBytes: 5_000_000, maxPixels: 10_000_000 });
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(2200);
    expect(img.height).toBeGreaterThan(img.width); // 3000x1000 rotated 90 degrees
  });

  it('removes EXIF/GPS metadata from the normalised image', async () => {
    const withMeta = await sharp({
      create: { width: 50, height: 50, channels: 3, background: '#fff' },
    })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret-owner' }, IFD3: { GPSLatitudeRef: 'S' } })
      .toBuffer();
    expect(withMeta.toString('latin1')).toContain('secret-owner'); // sanity: it was there
    const { png } = await prepareImage(withMeta, LIMITS);
    expect(png.toString('latin1')).not.toContain('secret-owner');
    const meta = await sharp(png).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it('rejects empty input, oversize input and non-images by content, not by name', async () => {
    await expect(prepareImage(Buffer.alloc(0), LIMITS)).rejects.toMatchObject({
      reason: 'not_an_image',
    });
    await expect(prepareImage(Buffer.alloc(2_000_000, 1), LIMITS)).rejects.toMatchObject({
      reason: 'too_large',
    });
    await expect(
      prepareImage(Buffer.from('<?php system($_GET[0]); ?>'), LIMITS),
    ).rejects.toMatchObject({
      reason: 'unsupported',
    });
    await expect(prepareImage(Buffer.from('%PDF-1.7 ...'), LIMITS)).rejects.toMatchObject({
      reason: 'unsupported',
    });
    await expect(prepareImage(Buffer.from('GIF89a......'), LIMITS)).rejects.toMatchObject({
      reason: 'unsupported',
    });
  });

  it('rejects an image with a valid header but a corrupt body', async () => {
    const good = await solid(200, 200, 'jpeg');
    const truncated = good.subarray(0, Math.floor(good.length / 3));
    await expect(prepareImage(truncated, LIMITS)).rejects.toBeInstanceOf(InvalidImageError);
    const garbage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(500, 7)]);
    await expect(prepareImage(garbage, LIMITS)).rejects.toBeInstanceOf(InvalidImageError);
  });

  it('rejects a decompression bomb by pixel count before decoding it', async () => {
    // A small file that declares a huge canvas.
    const bomb = await sharp({
      create: { width: 6000, height: 6000, channels: 3, background: '#fff' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(1_000_000); // small on disk...
    await expect(prepareImage(bomb, LIMITS)).rejects.toMatchObject({ reason: 'too_many_pixels' }); // ...huge in memory
  });
});

describe('sniffFormat', () => {
  it('ignores any claimed type: only magic bytes count', () => {
    expect(sniffFormat(Buffer.from('not an image.jpg'))).toBeNull();
    expect(sniffFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
  });
});
