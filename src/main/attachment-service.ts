import { dialog, nativeImage, type BrowserWindow } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_NAME_LENGTH,
  ATTACHMENT_MAX_SINGLE_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  isAttachmentPayloadList,
  type AttachmentPayload,
  type CapturePayload,
} from '../shared/types';

const PREVIEW_MAX_WIDTH = 320;
const PREVIEW_MAX_HEIGHT = 220;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
};

/** Keeps filesystem access and attachment shaping in the privileged process. */
export class AttachmentService {
  constructor(private readonly ownerWindow: () => BrowserWindow | null) {}

  async pickFiles(): Promise<AttachmentPayload[]> {
    const owner = this.ownerWindow();
    const result = owner
      ? await dialog.showOpenDialog(owner, this.dialogOptions())
      : await dialog.showOpenDialog(this.dialogOptions());
    if (result.canceled || result.filePaths.length === 0) return [];
    if (result.filePaths.length > ATTACHMENT_MAX_COUNT) {
      throw new Error(`You can attach up to ${ATTACHMENT_MAX_COUNT} files at a time.`);
    }

    const attachments: AttachmentPayload[] = [];
    let total = 0;
    for (const filePath of result.filePaths) {
      const attachment = await this.readFile(filePath);
      total += attachment.size;
      if (total > ATTACHMENT_MAX_TOTAL_BYTES) throw new Error('Attachments exceed the 20 MB total limit.');
      attachments.push(attachment);
    }
    return attachments;
  }

  fromCapture(capture: CapturePayload): AttachmentPayload {
    const data = new Uint8Array(capture.buffer);
    if (data.byteLength === 0 || capture.width < 1 || capture.height < 1) {
      throw new Error('Screen capture returned an empty image. Check Windows capture permissions.');
    }
    const extension = capture.mimeType === 'image/png' ? 'png' : 'jpg';
    return this.createPayload(
      `codex-capture-${capture.capturedAt}.${extension}`,
      capture.mimeType,
      data,
      capture.width,
      capture.height,
    );
  }

  /** Re-checks renderer-provided data before it reaches an API or browser. */
  validateIncoming(value: unknown): AttachmentPayload[] {
    if (!isAttachmentPayloadList(value)) throw new Error('Invalid attachment payload.');
    return value.map((attachment) => {
      const data = new Uint8Array(attachment.data);
      // Preview pixels are regenerated in this process. This avoids trusting a
      // renderer-supplied data URL and bounds the amount sent back over IPC.
      return this.createPayload(attachment.name, attachment.mimeType, data, attachment.width, attachment.height, attachment.id);
    });
  }

  private async readFile(filePath: string): Promise<AttachmentPayload> {
    const info = await fs.stat(filePath);
    if (!info.isFile()) throw new Error('Only regular files can be attached.');
    if (info.size < 1 || info.size > ATTACHMENT_MAX_SINGLE_BYTES) {
      throw new Error('Each attachment must be between 1 byte and 15 MB.');
    }
    const data = new Uint8Array(await fs.readFile(filePath));
    const name = sanitizeName(path.basename(filePath));
    const mimeType = MIME_BY_EXTENSION[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
    return this.createPayload(name, mimeType, data);
  }

  private createPayload(
    name: string,
    mimeType: string,
    data: Uint8Array,
    width?: number,
    height?: number,
    id: string = crypto.randomUUID(),
  ): AttachmentPayload {
    if (data.byteLength < 1 || data.byteLength > ATTACHMENT_MAX_SINGLE_BYTES) {
      throw new Error('Each attachment must be between 1 byte and 15 MB.');
    }
    const safeName = sanitizeName(name);
    const safeMime = sanitizeMime(mimeType);
    const dimensions = width && height ? { width, height } : undefined;
    const preview = safeMime.startsWith('image/') ? createPreview(data) : undefined;
    return {
      id,
      name: safeName,
      mimeType: safeMime,
      size: data.byteLength,
      data,
      ...(preview ? { previewDataUrl: preview.dataUrl, width: preview.width, height: preview.height } : dimensions ?? {}),
    };
  }

  private dialogOptions(): Electron.OpenDialogOptions {
    return {
      title: 'Attach files to Codex',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: 'Documents', extensions: ['pdf', 'txt', 'md', 'csv', 'json', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
  }
}

function sanitizeName(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  return (normalized || 'attachment').slice(0, ATTACHMENT_MAX_NAME_LENGTH);
}

function sanitizeMime(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(normalized) ? normalized.slice(0, 128) : 'application/octet-stream';
}

function createPreview(data: Uint8Array): { dataUrl: string; width: number; height: number } | null {
  try {
    const image = nativeImage.createFromBuffer(Buffer.from(data));
    if (image.isEmpty()) return null;
    const original = image.getSize();
    if (!original.width || !original.height) return null;
    const scale = Math.min(1, PREVIEW_MAX_WIDTH / original.width, PREVIEW_MAX_HEIGHT / original.height);
    const width = Math.max(1, Math.round(original.width * scale));
    const height = Math.max(1, Math.round(original.height * scale));
    const preview = scale < 1 ? image.resize({ width, height, quality: 'good' }) : image;
    const encoded = preview.toJPEG(78);
    return { dataUrl: `data:image/jpeg;base64,${encoded.toString('base64')}`, width, height };
  } catch {
    return null;
  }
}

export const ATTACHMENT_LIMITS = {
  maxCount: ATTACHMENT_MAX_COUNT,
  maxTotalBytes: ATTACHMENT_MAX_TOTAL_BYTES,
  maxSingleBytes: ATTACHMENT_MAX_SINGLE_BYTES,
} as const;
