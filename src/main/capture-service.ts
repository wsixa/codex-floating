import { desktopCapturer, nativeImage, screen } from 'electron';
import type { CapturePayload, CaptureRegion } from '../shared/types';

const MAX_PIXELS = 16_000 * 16_000;
const JPEG_QUALITY = 84;

export class CaptureService {
  async captureFullScreen(): Promise<CapturePayload> {
    const display = screen.getPrimaryDisplay();
    const source = await withTimeout(this.findScreenSource(String(display.id), display.bounds.width, display.bounds.height), 5_000, 'Screen capture timed out.');
    const image = source.thumbnail;
    const size = image.getSize();
    const buffer = image.toJPEG(JPEG_QUALITY);
    return {
      buffer,
      mimeType: 'image/jpeg',
      width: size.width,
      height: size.height,
      capturedAt: Date.now(),
    };
  }

  async captureRegion(region: CaptureRegion): Promise<CapturePayload> {
    this.assertRegion(region);
    const display = screen.getPrimaryDisplay();
    const source = await withTimeout(this.findScreenSource(String(display.id), display.bounds.width, display.bounds.height), 5_000, 'Screen capture timed out.');
    const sourceSize = source.thumbnail.getSize();
    const scaleX = sourceSize.width / display.bounds.width;
    const scaleY = sourceSize.height / display.bounds.height;
    const crop = {
      x: Math.round(region.x * scaleX),
      y: Math.round(region.y * scaleY),
      width: Math.round(region.width * scaleX),
      height: Math.round(region.height * scaleY),
    };
    crop.x = Math.max(0, Math.min(crop.x, sourceSize.width - 1));
    crop.y = Math.max(0, Math.min(crop.y, sourceSize.height - 1));
    crop.width = Math.max(1, Math.min(crop.width, sourceSize.width - crop.x));
    crop.height = Math.max(1, Math.min(crop.height, sourceSize.height - crop.y));
    const image = source.thumbnail.crop(crop);
    const size = image.getSize();
    return {
      buffer: image.toJPEG(JPEG_QUALITY),
      mimeType: 'image/jpeg',
      width: size.width,
      height: size.height,
      capturedAt: Date.now(),
    };
  }

  private async findScreenSource(displayId: string, width: number, height: number) {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.max(1, Math.round(width * 1.5)), height: Math.max(1, Math.round(height * 1.5)) },
      fetchWindowIcons: false,
    });
    const exact = sources.find((source) => source.display_id === displayId);
    const source = exact ?? sources[0];
    if (!source) throw new Error('No screen capture source is available. Check Windows capture permissions.');
    return source;
  }

  private assertRegion(region: CaptureRegion): void {
    if (!Number.isFinite(region.x) || !Number.isFinite(region.y) ||
      !Number.isFinite(region.width) || !Number.isFinite(region.height) ||
      region.width <= 0 || region.height <= 0 || region.x < 0 || region.y < 0 ||
      region.width * region.height > MAX_PIXELS) {
      throw new Error('Capture region is invalid or too large.');
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function compressCapture(payload: CapturePayload, quality = 82): CapturePayload {
  // Captures are encoded once in captureFullScreen/captureRegion; this is only a fallback for PNG payloads.
  if (payload.mimeType !== 'image/png') return payload;
  const image = nativeImage.createFromBuffer(Buffer.from(payload.buffer));
  const jpeg = image.toJPEG(Math.max(40, Math.min(95, quality)));
  return { ...payload, buffer: jpeg, mimeType: 'image/jpeg' };
}
