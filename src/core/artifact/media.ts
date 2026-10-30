import { validateZip } from './zip.js';

const ZIP_MAGIC = Buffer.from('504b0304', 'hex');
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
const JPEG_MAGIC = Buffer.from('ffd8ff', 'hex');
const GIF87_MAGIC = Buffer.from('GIF87a');
const GIF89_MAGIC = Buffer.from('GIF89a');
const PDF_MAGIC = Buffer.from('%PDF-');

function starts(bytes: Buffer, signature: Buffer): boolean {
  return bytes.length >= signature.length && bytes.subarray(0, signature.length).equals(signature);
}

/** A missing platform declaration may be filled from signatures; explicit declarations are never overwritten. */
export function detectRecognizedMediaType(bytes: Buffer): string | null {
  if (starts(bytes, ZIP_MAGIC)) return 'application/zip';
  if (starts(bytes, PNG_MAGIC)) return 'image/png';
  if (starts(bytes, JPEG_MAGIC)) return 'image/jpeg';
  if (starts(bytes, GIF87_MAGIC) || starts(bytes, GIF89_MAGIC)) return 'image/gif';
  if (starts(bytes, PDF_MAGIC)) return 'application/pdf';
  return null;
}

/** Checks recognized formats against the declaration; unknown binary remains opaque. */
export function validateArtifactBytes(path: string, bytes: Buffer, mediaType: string): void {
  if (!Buffer.isBuffer(bytes) || bytes.length > 32 * 1024 * 1024) throw new Error('File budget exceeded');
  const zip = starts(bytes, ZIP_MAGIC);
  const normalizedType = mediaType.toLowerCase().split(';', 1)[0]?.trim();
  const expectedZip = path.toLowerCase().endsWith('.zip') || normalizedType === 'application/zip';
  if (expectedZip !== zip) throw new Error('Artifact media type mismatch: ZIP');
  if (zip) {
    if (normalizedType !== 'application/zip') throw new Error('Artifact media type mismatch: ZIP');
    validateZip(bytes);
    return;
  }
  const signatures: ReadonlyArray<readonly [string, Buffer[]]> = [
    ['image/png', [PNG_MAGIC]],
    ['image/jpeg', [JPEG_MAGIC]],
    ['image/gif', [GIF87_MAGIC, GIF89_MAGIC]],
    ['application/pdf', [PDF_MAGIC]],
  ];
  for (const [type, magic] of signatures) {
    const identified = magic.some((signature) => starts(bytes, signature));
    if ((normalizedType === type) !== identified) {
      if (normalizedType === type || identified) throw new Error(`Artifact media type mismatch: ${type}`);
    }
  }
}
