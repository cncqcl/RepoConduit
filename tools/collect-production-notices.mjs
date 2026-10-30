import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

// Bounded development-time license inventory, not a runtime/supply-chain attestation.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const lockBytes = readFileSync('package-lock.json');
const lock = JSON.parse(lockBytes.toString('utf8'));
assert.equal(lock.lockfileVersion, 3);
const entries = Object.entries(lock.packages).filter(([path, value]) => path && !value.dev);
assert.ok(entries.length > 0 && entries.length <= 100);
const rows = [];
const sections = [];
let directoryEntries = 0;
let textBytes = 0;
for (const [path, locked] of entries.sort(([a], [b]) => a.localeCompare(b))) {
  assert.match(path, /^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/);
  assert.ok(!path.split('/').some(part => part === '.' || part === '..'));
  assert.ok(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink());
  const manifest = JSON.parse(readFileSync(`${path}/package.json`, 'utf8'));
  assert.equal(manifest.version, locked.version, `${path}: version mismatch`);
  assert.equal(manifest.license, locked.license, `${path}: license mismatch`);
  const names = readdirSync(path);
  directoryEntries += names.length;
  assert.ok(directoryEntries <= 5000, 'License inventory directory budget exceeded');
  const candidates = names.filter(name => /^(licen[sc]e|copying|notice|copyright)([.\-_]|$)/i.test(name)).sort();
  const notices = [];
  for (const name of candidates) {
    const file = `${path}/${name}`;
    const stat = lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 512 * 1024);
    const bytes = readFileSync(file);
    textBytes += bytes.length;
    assert.ok(textBytes <= 10 * 1024 * 1024, 'License text budget exceeded');
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    notices.push({ file, bytes: bytes.length, sha256: hash(bytes) });
    sections.push(`## ${manifest.name}@${manifest.version} — ${name}\n\n` +
      `Source: \`${file}\`; declared license: ${manifest.license}.\n` +
      `Original notice SHA-256: \`${hash(bytes)}\`.\n\n` +
      `${body.replace(/\r\n/g, '\n').trimEnd()}\n`);
  }
  rows.push({ path, name: manifest.name, version: manifest.version,
    declared_license: manifest.license,
    status: notices.length ? 'text_captured' : 'notice_text_missing', notices });
}
const missing = rows.filter(row => !row.notices.length);
const inventory = {
  schema_version: '1', kind: 'production_license_text_inventory_not_release_verdict',
  lock_sha256: hash(lockBytes), production_entries: rows.length,
  directory_entries_observed: directoryEntries, notice_bytes_read: textBytes,
  status: missing.length ? 'incomplete' : 'texts_captured_pending_review',
  missing_notice_packages: missing.map(row => `${row.name}@${row.version}`), packages: rows,
};
writeFileSync('docs/PRODUCTION_LICENSE_INVENTORY.json', JSON.stringify(inventory, null, 2) + '\n');
writeFileSync('docs/THIRD_PARTY_NOTICES.md', '# Production dependency notices\n\n' +
  'Generated in the source checkout from installed packages matching package-lock.json by ' +
  '`node tools/collect-production-notices.mjs`. Original byte hashes are in ' +
  '`PRODUCTION_LICENSE_INVENTORY.json`; displayed text uses LF line endings.\n\n' +
  'This document preserves supplied notices. It does not license RepoConduit, ' +
  'approve redistribution or certify release readiness. Development dependencies ' +
  'and unbundled external runtimes are outside this production-package inventory.\n\n' +
  (missing.length ? `Missing notice text: ${missing.map(row => `${row.name}@${row.version}`).join(', ')}.\n\n` : '') +
  sections.join('\n'));
console.log(JSON.stringify({ status: inventory.status, production_entries: rows.length,
  captured_entries: rows.length - missing.length, missing: inventory.missing_notice_packages,
  directory_entries_observed: directoryEntries, notice_bytes_read: textBytes }));
