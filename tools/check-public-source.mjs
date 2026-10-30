import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, relative, sep } from 'node:path';

// Bounded review aid for the proposed source tree. Never scans Git history,
// ignored installation data, node_modules, external accounts or the OS runtime.
const root = resolve('.');
const listed = spawnSync('git', ['ls-files', '--stage', '-z'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
assert.equal(listed.status, 0, 'Cannot list the Git index');
const entries = listed.stdout.split('\0').filter(Boolean).map(entry => {
  const match = /^(100644|100755) ([0-9a-f]{40,64}) 0\t(.+)$/.exec(entry);
  assert.ok(match, 'Index must contain regular files and no merge conflicts');
  return { oid: match[2], file: match[3] };
});
const files = entries.map(entry => entry.file);
assert.ok(entries.length > 0 && entries.length <= 10000, 'Source file budget exceeded');
const selected = entries.map(entry => entry.oid).join('\n') + '\n';
const inspected = spawnSync('git', ['cat-file', '--batch-check'], {
  input: selected, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
assert.equal(inspected.status, 0, 'Cannot inspect indexed blobs');
const sizes = inspected.stdout.trim().split('\n').map(line => {
  const match = /^[0-9a-f]{40,64} blob ([0-9]+)$/.exec(line);
  assert.ok(match, 'Invalid indexed blob');
  const size = Number(match[1]);
  assert.ok(size <= 2 * 1024 * 1024, 'Indexed file exceeds 2 MiB');
  return size;
});
assert.equal(sizes.length, entries.length);
assert.ok(sizes.reduce((sum, size) => sum + size, 0) <= 128 * 1024 * 1024, 'Source byte budget exceeded');
const blobs = spawnSync('git', ['cat-file', '--batch'], {
  input: selected, maxBuffer: 130 * 1024 * 1024 });
assert.equal(blobs.status, 0, 'Cannot read indexed blobs');
const problems = [];
const denied = /^(?:verification\/(?:probes|receipts|logs|live)\/|provenance\/|node_modules\/|dist\/|\.local\/)|\.(?:sqlite(?:-.*)?|db|pem|key|tgz|exe)$/i;
const privateLocator = /(?:plugin_asdk_app_[a-z0-9]{16,}|tunnel_[a-z0-9_-]{20,}|chatgpt\.com\/(?:c|space\/page_)\/[a-f0-9-]{20,})/i;
const credential = /(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{48,}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
let bytes = 0, links = 0;
let cursor = 0;
for (const [entryIndex, { file, oid }] of entries.entries()) {
  if (denied.test(file)) problems.push(`${file}: private/generated file in source index`);
  const path = resolve(root, file);
  const end = blobs.stdout.indexOf(10, cursor);
  assert.ok(end >= cursor);
  assert.equal(blobs.stdout.subarray(cursor, end).toString('utf8'), `${oid} blob ${sizes[entryIndex]}`);
  cursor = end + 1;
  const buffer = blobs.stdout.subarray(cursor, cursor + sizes[entryIndex]);
  cursor += sizes[entryIndex];
  assert.equal(blobs.stdout[cursor++], 10);
  bytes += buffer.length;
  if (buffer.includes(0)) continue; // Binary fixtures need human review.
  const text = buffer.toString('utf8');
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (credential.test(line)) problems.push(`${file}:${index + 1}: possible credential`);
    const redactedSynthetic = line.replace(/https:\/\/chatgpt\.com\/c\/(?:11111111-1111-4111-8111-111111111111|66666666-6666-4666-8666-666666666666)/g, 'SYNTHETIC_CHAT');
    if (privateLocator.test(redactedSynthetic)) problems.push(`${file}:${index + 1}: private connection/chat locator`);
  }
  if (!file.endsWith('.md')) continue;
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    let target = match[1].split(/\s+"/)[0].replace(/^<|>$/g, '');
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
    target = decodeURIComponent(target.split('#')[0]);
    if (!target) continue;
    const dest = resolve(dirname(path), target);
    const indexedTarget = relative(root, dest).replaceAll('\\', '/');
    if (relative(root, dest).startsWith('..' + sep) ||
        !files.some(candidate => candidate === indexedTarget || candidate.startsWith(indexedTarget + '/'))) {
      problems.push(`${file}: broken local link ${target}`);
    }
    links++;
  }
}
console.log(JSON.stringify({ files: files.length, bytes, localLinksChecked: links,
  findings: problems.length, scope: 'actual indexed blobs; no history or binary-content assurance' }));
for (const problem of problems) console.error(problem);
if (problems.length) process.exitCode = 1;
