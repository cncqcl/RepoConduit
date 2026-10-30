export function syntheticFileObservation(
  runId: string,
  file: { download_url: string; file_id: string; mime_type?: string; file_name?: string },
  bytes: Uint8Array,
): {
  runId: string;
  kind: 'file_reference';
  fileIdSha256: string;
  downloadOrigin: string;
  hasMimeType: boolean;
  hasFileName: boolean;
  byteCount: number;
  byteSha256: string;
};
