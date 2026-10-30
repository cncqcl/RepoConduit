export interface BundleInput {
  bundleId: string;
  workspaceId: string;
  collaborationId: string;
  contextRevision: string;
  snapshotRefs: string[];
  parentBundleId?: string;
  expectedPaths?: string[];
}

export interface ArtifactFile {
  normalizedRelativePath: string;
  actualSizeBytes: number;
  sha256: string;
  mediaType: string;
  sourceReceipt: string;
  sourceIdentity?: string;
}

export interface BundleManifest extends BundleInput {
  expectedSetBasis: 'producer_declared' | 'receiver_observed';
  files: ArtifactFile[];
  semanticStatus: 'not_reviewed';
}

export interface DeliveryState {
  state: 'staging' | 'published' | 'aborted';
  missingPaths: string[];
  files: ArtifactFile[];
}
