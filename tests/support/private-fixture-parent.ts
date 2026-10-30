import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPrivateInstallationDirectory, protectNewDataDirectory } from
  '../../src/runtime/local-security.js';

let created: string | undefined;

/** Only fresh test directories are secured; an explicit existing parent is validated. */
export function privateFixtureParent(): string {
  const selected = process.env.RCAC_TEST_PRIVATE_PARENT;
  if (selected) {
    assertPrivateInstallationDirectory(selected);
    return selected;
  }
  if (!created) {
    created = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-test-parent-'));
    protectNewDataDirectory(created);
  }
  return created;
}
