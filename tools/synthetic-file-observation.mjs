import { createHash } from 'node:crypto';

/** Synthetic evidence only: record byte identity without returning the source URL or contents. */
export function syntheticFileObservation(runId, file, bytes) {
  return {
    runId,
    kind: 'file_reference',
    fileIdSha256: createHash('sha256').update(file.file_id).digest('hex'),
    downloadOrigin: new URL(file.download_url).origin,
    hasMimeType: typeof file.mime_type === 'string',
    hasFileName: typeof file.file_name === 'string',
    byteCount: bytes.length,
    byteSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
