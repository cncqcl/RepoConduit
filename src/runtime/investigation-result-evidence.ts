import {createHash} from 'node:crypto';
import type {RepositorySnapshot} from '../adapters/repository/snapshots.js';
import type {SucceededInvestigationReadReceipt, SucceededCodexInvestigationReadReceipt} from
  '../adapters/storage/investigation-sqlite.js';
import type {ParsedInvestigationResult} from '../core/investigation/result.js';

export type TrustedInvestigationResultBinding = Pick<SucceededInvestigationReadReceipt,
  'requestId' | 'attemptId' | 'workspaceId' | 'collaborationId' | 'workingCopyId' |
  'snapshotId' | 'contextRevisionId' | 'launchEpoch' | 'nativeRef' |
  'workerPrincipal' | 'workerAudience' | 'workerRecipient' | 'workerGrantId'>;

export type TrustedCodexInvestigationResultBinding =
  Omit<TrustedInvestigationResultBinding, 'nativeRef'> &
  Pick<SucceededCodexInvestigationReadReceipt, 'intentId' | 'threadId' | 'turnId'>;

function conflict(): never { throw new Error('INVALID_INVESTIGATION_RESULT'); }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function line(bytes: Buffer, boundary: number): number {
  let count = 1;
  for (let i = 0; i < boundary; i++) if (bytes[i] === 10) count++;
  return count;
}
function exactText(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', {fatal: true,ignoreBOM:true}).decode(bytes); }
  catch { return conflict(); }
}
function covers(bytes: Buffer, ranges: readonly [number, number][]): boolean {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let end = 0;
  for (const range of sorted) {
    if (range[0] > end) return false;
    end = Math.max(end, range[1]);
  }
  return end >= bytes.length;
}

/** Pure exact-byte comparison against trusted snapshot and successful read ledger. */
export function validateInvestigationResultEvidence(result: ParsedInvestigationResult,
  receipts: readonly (SucceededInvestigationReadReceipt | SucceededCodexInvestigationReadReceipt)[],
  snapshot: RepositorySnapshot,
  binding: TrustedInvestigationResultBinding | TrustedCodexInvestigationResultBinding): void {
  const common = ['requestId','attemptId','workspaceId','collaborationId','workingCopyId',
    'snapshotId','contextRevisionId','launchEpoch','workerPrincipal','workerAudience',
    'workerRecipient','workerGrantId'] as const;
  const identity = 'nativeRef' in binding ? ['nativeRef'] : ['intentId','threadId','turnId'];
  const keys = [...common,...identity];
  if (Object.keys(binding).length !== keys.length || keys.some(key =>
    !Object.hasOwn(binding,key)) || !Number.isSafeInteger(binding.launchEpoch) ||
    binding.launchEpoch < 1 || keys.filter(key=>key!=='launchEpoch').some(key=>
      typeof (binding as unknown as Record<string,unknown>)[key] !== 'string' ||
      !(binding as unknown as Record<string,string>)[key]?.trim())) conflict();
  if (result.requestId !== binding.requestId || result.attemptId !== binding.attemptId ||
    result.snapshotRef !== binding.snapshotId ||
    result.contextRevisionId !== binding.contextRevisionId ||
    snapshot.id !== binding.snapshotId || snapshot.workingCopyId !== binding.workingCopyId ||
    receipts.length === 0 || receipts.length > 40) conflict();
  const byId = new Map<string, SucceededInvestigationReadReceipt | SucceededCodexInvestigationReadReceipt>();
  const byPath = new Map<string, [number, number][]>();
  for (const receipt of receipts) {
    if (byId.has(receipt.id) ||
      ('nativeRef' in receipt) !== ('nativeRef' in binding) ||
      keys.some(key => (receipt as unknown as Record<string,unknown>)[key] !==
        (binding as unknown as Record<string,unknown>)[key]) ||
      !Number.isFinite(Date.parse(receipt.reservedAt)) ||
      !Number.isFinite(Date.parse(receipt.observedAt)) ||
      Date.parse(receipt.observedAt) < Date.parse(receipt.reservedAt)) conflict();
    const file = snapshot.file(receipt.path);
    const entry = snapshot.manifest.find(item => item.path === receipt.path);
    const [start, end] = receipt.byteRange;
    if (!file || !entry || entry.sha256 !== receipt.fullContentHash ||
      hash(file) !== receipt.fullContentHash || !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) || start < 0 || end <= start || end > file.length ||
      hash(file.subarray(start, end)) !== receipt.pageContentHash ||
      receipt.lineRange[0] !== line(file, start) ||
      receipt.lineRange[1] !== line(file, end - 1) ||
      (receipt.completeness === 'complete') !== (end === file.length) ||
      exactText(file.subarray(start, end)) === undefined) conflict();
    byId.set(receipt.id, receipt);
    byPath.set(receipt.path, [...(byPath.get(receipt.path) ?? []), receipt.byteRange]);
  }
  for (const item of result.evidence) {
    const receipt = byId.get(item.toolReceipt);
    if (!receipt || receipt.path !== item.path ||
      item.contentHash !== receipt.fullContentHash ||
      item.byteRange[0] < receipt.byteRange[0] ||
      item.byteRange[1] > receipt.byteRange[1]) conflict();
    const file = snapshot.file(item.path)!;
    const [start, end] = item.byteRange;
    if (item.excerpt !== exactText(file.subarray(start, end)) ||
      item.lineRange[0] !== line(file, start) ||
      item.lineRange[1] !== line(file, end - 1)) conflict();
  }
  const paths = [...byPath.keys()].sort();
  const excluded = [...new Set(snapshot.exclusions.map(item => item.reason))].sort();
  const truncated = paths.some(path => !covers(snapshot.file(path)!, byPath.get(path)!));
  if (JSON.stringify([...result.coverage.searchedScope].sort()) !== JSON.stringify(paths) ||
    JSON.stringify([...result.coverage.excludedCategories].sort()) !== JSON.stringify(excluded) ||
    result.coverage.truncated !== truncated) conflict();
}
