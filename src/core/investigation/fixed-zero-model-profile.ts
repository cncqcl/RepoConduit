import { createHash } from 'node:crypto';

/** A versioned fixed diagnostic action identifier; not a binary attestation. */
export const FIXED_ZERO_MODEL_PROFILE_DIGEST = createHash('sha256')
  .update('native_supervisor_v2:fixed_zero_model_v1', 'utf8').digest('hex');
