import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { InvestigationSourcePlan } from '../../src/application/investigation-source-plan.js';
import { parseWslSourceViewOutput, wslSourceViewSpec } from '../../src/adapters/codex/investigator/source-view.js';

const id = '11111111-1111-4111-8111-111111111111';
const binding = {
  workspaceId: `ws_${id}`, collaborationId: `collab_${id}`, workingCopyId: `copy_${id}`,
  snapshotRef: `snap_${id}`, contextRevisionId: `ctx_${id}`, recipient: 'tester',
  requestId: `inv_${id}`, attemptId: `attempt_${id}`, workerEpoch: 1,
};
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function plan(paths: string[] = ['src/a.ts']): InvestigationSourcePlan {
  const files = paths.map(path => {
    const bytes = Buffer.from('selected bytes\n');
    return { path, sizeBytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') };
  });
  return { binding, sourceConsistency: 'verified_git_tree', files,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    digest: sha(JSON.stringify({ binding, sourceConsistency: 'verified_git_tree',
      files: files.map(({ path, sizeBytes, sha256 }) => ({ path, sizeBytes, sha256 })) })) };
}
const descriptor = { distro: 'Ubuntu', linuxUser: 'tester', uid: 1000,
  attemptId: binding.attemptId, workspaceId: binding.workspaceId, workerEpoch: 1,
  sourceDigest: plan().digest, bootId: id };
const root = '/home/tester/.local/share/rcac/source-views';

test('fixed helper launch accepts only a bounded exact source plan', () => {
  const spec = wslSourceViewSpec('materialize', descriptor, root, plan());
  assert.equal(spec.executable, 'C:\\Windows\\System32\\wsl.exe');
  assert.deepEqual(spec.args.slice(0, 10), ['-d', 'Ubuntu', '--user', 'tester', '--cd', '/', '--exec',
    '/usr/bin/python3', '-I', '-S']);
  assert.equal(spec.args[10], '-c');
  assert.deepEqual(Object.keys(spec.env).sort(), ['PATH', 'SystemRoot']);
  assert.deepEqual(JSON.parse(spec.input).files.map((file: {path: string}) => file.path), ['src/a.ts']);
  assert.ok(!spec.args.join(' ').includes('selected bytes'));
});

test('rejects traversal, aliases, changed bytes and injected fields before launch', () => {
  for (const paths of [['../escape'], ['/absolute'], ['a\\b'], ['src/A.ts', 'src/a.ts'],
    ['src/X/a.ts', 'src/x/b.ts'],
    ['src/a.ts', 'src/a.ts'], ['src/.env'], ['.source-view.json'],
    ['src/a.ts', 'src/a.ts/child']]) {
    const candidate = plan(paths);
    assert.throws(() => wslSourceViewSpec('materialize',
      { ...descriptor, sourceDigest: candidate.digest }, root, candidate),
      { message: 'INVALID_ARGUMENT' });
  }
  const changed = plan(); changed.files[0]!.base64 = Buffer.from('other').toString('base64');
  assert.throws(() => wslSourceViewSpec('materialize', descriptor, root, changed), { message: 'INVALID_ARGUMENT' });
  const extra = Object.assign(plan(), { executable: '/bin/sh' });
  assert.throws(() => wslSourceViewSpec('materialize', descriptor, root, extra), { message: 'INVALID_ARGUMENT' });
  assert.throws(() => wslSourceViewSpec('materialize', descriptor, '/mnt/c/sibling', plan()), { message: 'INVALID_ARGUMENT' });
  assert.throws(() => wslSourceViewSpec('materialize', descriptor, '/home/tester//private', plan()), { message: 'INVALID_ARGUMENT' });
  assert.throws(() => wslSourceViewSpec('close', descriptor, root, plan()), { message: 'INVALID_ARGUMENT' });
});

test('close is a separate fixed operation with no source bytes', () => {
  const spec = wslSourceViewSpec('close', descriptor, root);
  assert.equal(spec.input, '');
  assert.equal(spec.args.at(-5), descriptor.workspaceId);
});

test('rejects forged helper output', () => {
  const ready = { attemptId: descriptor.attemptId, workspaceId: descriptor.workspaceId,
    uid: descriptor.uid, workerEpoch: descriptor.workerEpoch, bootId: descriptor.bootId,
    kind: 'ready', digest: descriptor.sourceDigest };
  assert.equal(parseWslSourceViewOutput('null\n', descriptor), null);
  assert.deepEqual(parseWslSourceViewOutput(`${JSON.stringify(ready)}\n`, descriptor), ready);
  assert.throws(() => parseWslSourceViewOutput(`${JSON.stringify({ ...ready, digest: '0'.repeat(64) })}\n`, descriptor));
  assert.throws(() => parseWslSourceViewOutput(`${JSON.stringify({ ...ready, extra: 'x' })}\n`, descriptor));
});

test('WSL close recovers claimed interrupted staging without touching foreign entries',
  { skip: process.platform !== 'win32' }, () => {
  const run = (args: string[], input = '') => spawnSync('C:\\Windows\\System32\\wsl.exe', args,
    { input, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
  const installed = run(['-l', '-q']);
  assert.equal(installed.status, 0, installed.stderr);
  const distro = installed.stdout.replaceAll('\0', '').split(/\r?\n/)[0]?.trim();
  assert.ok(distro);
  const info = run(['-d', distro, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
    'import os; print(os.environ.get("USER", "")); print(os.getuid()); print(open("/proc/sys/kernel/random/boot_id").read().strip())']);
  assert.equal(info.status, 0, info.stderr);
  const [linuxUser, uidText, bootId] = info.stdout.trim().split(/\r?\n/);
  assert.ok(linuxUser && uidText && bootId);
  const actual = { ...descriptor, distro, linuxUser, uid: Number(uidText), bootId };
  const source = plan();
  const marker = { attemptId: actual.attemptId, workspaceId: actual.workspaceId,
    uid: actual.uid, workerEpoch: actual.workerEpoch, bootId: actual.bootId,
    digest: actual.sourceDigest, binding: source.binding,
    sourceConsistency: source.sourceConsistency,
    files: source.files.map(({ path, sizeBytes, sha256 }) => ({ path, sizeBytes, sha256 })) };
  const roots: string[] = [];
  const makeRoot = () => {
    const result = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/mktemp', '-d',
      `/home/${linuxUser}/.rcac-source-view-test-XXXXXXXX`]);
    assert.equal(result.status, 0, result.stderr);
    const path = result.stdout.trim(); roots.push(path); return path;
  };
  const stage = `${actual.attemptId}.${'a'.repeat(32)}.staging`;
  const inject = (rootPath: string, mode: 'claim-only' | 'partial-marker' | 'source-absent' | 'partial-file' | 'foreign' | 'wrong-complete' | 'wrong-identity') => {
    const script = `import json,os,sys\nroot,stage,mode=sys.argv[1:]\nm=json.load(sys.stdin)\nclaim=root+'/'+stage+'.claim'\nclaimed=dict(m)\nif mode=='wrong-identity': claimed['workspaceId']='ws_00000000-0000-4000-8000-000000000000'\nwith open(claim,'w') as f: json.dump(claimed,f,separators=(',',':'))\nos.chmod(claim,0o600)\nif mode!='claim-only':\n os.mkdir(root+'/'+stage,0o700)\n p=root+'/'+stage+'/.source-view.json'\n with open(p,'w') as f: f.write(json.dumps(m,separators=(',',':'))[:20 if mode=='partial-marker' else None])\n os.chmod(p,0o400)\n if mode!='partial-marker':\n  os.mkdir(root+'/'+stage+'/src',0o700)\n  if mode!='source-absent':\n   with open(root+'/'+stage+'/src/a.ts','wb') as f: f.write(b'X'*m['files'][0]['sizeBytes'] if mode=='wrong-complete' else b'wrong' if mode=='foreign' else b'selected')\n   os.chmod(root+'/'+stage+'/src/a.ts',0o400)\n if mode=='foreign':\n  with open(root+'/'+stage+'/foreign','w') as f: f.write('preserve')\n`;
    const result = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S',
      '-c', script, rootPath, stage, mode], JSON.stringify(marker));
    assert.equal(result.status, 0, result.stderr);
  };
  const close = (rootPath: string) => {
    const spec = wslSourceViewSpec('close', actual, rootPath);
    return spawnSync(spec.executable, spec.args, { input: '', env: spec.env,
      encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
  };
  try {
    for (const mode of ['claim-only', 'partial-marker', 'source-absent'] as const) {
      const rootPath = makeRoot(); inject(rootPath, mode);
      const statusSpec = wslSourceViewSpec('status', actual, rootPath);
      const pendingStatus = spawnSync(statusSpec.executable, statusSpec.args,
        { input: '', env: statusSpec.env, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
      assert.notEqual(pendingStatus.status, 0);
      const result = close(rootPath);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(parseWslSourceViewOutput(result.stdout, actual)?.kind, 'closed');
      const entries = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/ls', '-A', rootPath]);
      assert.equal(entries.status, 0, entries.stderr);
      assert.equal(entries.stdout.includes(stage), false);
    }
    const rootPath = makeRoot(); inject(rootPath, 'foreign');
    assert.notEqual(close(rootPath).status, 0);
    const preserved = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/cat',
      `${rootPath}/${stage}/foreign`]);
    assert.equal(preserved.stdout, 'preserve');
    const shortRoot = makeRoot(); inject(shortRoot, 'partial-file');
    assert.notEqual(close(shortRoot).status, 0);
    const shortFile = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/cat',
      `${shortRoot}/${stage}/src/a.ts`]);
    assert.equal(shortFile.stdout, 'selected');
    for (const mode of ['wrong-complete', 'wrong-identity'] as const) {
      const unsafeRoot = makeRoot(); inject(unsafeRoot, mode);
      assert.notEqual(close(unsafeRoot).status, 0);
      const preservedStage = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/ls',
        '-A', `${unsafeRoot}/${stage}`]);
      assert.equal(preservedStage.status, 0, preservedStage.stderr);
    }
    const tempRoot = makeRoot();
    const interruptedClaim = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,sys; open(sys.argv[1],"wb").write(b"unverified partial claim")',
      `${tempRoot}/${stage}.claim.tmp`]);
    assert.equal(interruptedClaim.status, 0, interruptedClaim.stderr);
    assert.notEqual(close(tempRoot).status, 0);
    const retainedClaim = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/cat',
      `${tempRoot}/${stage}.claim.tmp`]);
    assert.equal(retainedClaim.stdout, 'unverified partial claim');
  } finally {
    for (const rootPath of roots) {
      assert.match(rootPath, new RegExp(`^/home/${linuxUser}/\\.rcac-source-view-test-[A-Za-z0-9]+$`));
      run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
        'import shutil,sys; shutil.rmtree(sys.argv[1])', rootPath]);
    }
  }
});

test('WSL source view publication never replaces a concurrent empty view',
  { skip: process.platform !== 'win32' }, () => {
  const run = (args: string[], input = '') => spawnSync('C:\\Windows\\System32\\wsl.exe', args,
    { input, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
  const installed = run(['-l', '-q']);
  assert.equal(installed.status, 0, installed.stderr);
  const distro = installed.stdout.replaceAll('\0', '').split(/\r?\n/)[0]?.trim();
  assert.ok(distro);
  const info = run(['-d', distro, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
    'import os; print(os.environ.get("USER", "")); print(os.getuid()); print(open("/proc/sys/kernel/random/boot_id").read().strip())']);
  assert.equal(info.status, 0, info.stderr);
  const [linuxUser, uidText, bootId] = info.stdout.trim().split(/\r?\n/);
  assert.ok(linuxUser && uidText && bootId);
  const actual = { ...descriptor, distro, linuxUser, uid: Number(uidText), bootId };
  const created = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/mktemp', '-d',
    `/home/${linuxUser}/.rcac-source-view-test-XXXXXXXX`]);
  assert.equal(created.status, 0, created.stderr);
  const privateRoot = created.stdout.trim();
  try {
    const spec = wslSourceViewSpec('materialize', actual, privateRoot, plan());
    const args = [...spec.args];
    const oldCall = "os.rename(stage, attempt + '.view', src_dir_fd=directory, dst_dir_fd=directory)";
    const newCall = "rename_view_noreplace(directory, stage, attempt + '.view')";
    const call = args[11]!.includes(newCall) ? newCall : oldCall;
    assert.ok(args[11]!.includes(call));
    args[11] = args[11]!.replace(call,
      "os.mkdir(attempt + '.view', 0o700, dir_fd=directory); " + call);
    const result = spawnSync(spec.executable, args, { input: spec.input, env: spec.env,
      encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
    assert.notEqual(result.status, 0);
    const emptyView = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/ls', '-A',
      `${privateRoot}/${actual.attemptId}.view`]);
    assert.equal(emptyView.status, 0, result.stderr + emptyView.stderr);
    assert.equal(emptyView.stdout, '');
  } finally {
    assert.match(privateRoot, new RegExp(`^/home/${linuxUser}/\\.rcac-source-view-test-[A-Za-z0-9]+$`));
    run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import shutil,sys; shutil.rmtree(sys.argv[1])', privateRoot]);
  }
});

test('WSL materialization, tamper refusal, close tombstone and sibling preservation', { skip: process.platform !== 'win32' }, () => {
  const run = (args: string[], input = '') => spawnSync('C:\\Windows\\System32\\wsl.exe', args,
    { input, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
  const installed = run(['-l', '-q']);
  assert.equal(installed.status, 0, installed.stderr);
  const distro = installed.stdout.replaceAll('\0', '').split(/\r?\n/)[0]?.trim();
  assert.ok(distro && distro !== 'docker-desktop');
  const info = run(['-d', distro, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
    'import os; print(os.getlogin() if False else os.environ.get("USER", "")); print(os.getuid()); print(open("/proc/sys/kernel/random/boot_id").read().strip())']);
  assert.equal(info.status, 0, info.stderr);
  const [linuxUser, uidText, bootId] = info.stdout.trim().split(/\r?\n/);
  assert.ok(linuxUser && uidText && bootId);
  const actual = { ...descriptor, distro, linuxUser, uid: Number(uidText), bootId };
  const makeRoot = () => {
    const output = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/mktemp', '-d',
      `/home/${linuxUser}/.rcac-source-view-test-XXXXXXXX`]);
    assert.equal(output.status, 0, output.stderr);
    return output.stdout.trim();
  };
  const roots = [makeRoot(), makeRoot(), makeRoot(), makeRoot(), makeRoot()];
  try {
    const invoke = (op: 'materialize' | 'close' | 'status', rootPath: string,
      identity = actual, timeout = 20_000) => {
      const spec = wslSourceViewSpec(op, identity, rootPath, op === 'materialize' ? plan() : undefined);
      return spawnSync(spec.executable, spec.args, { input: spec.input, env: spec.env,
        encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
    };
    assert.equal(parseWslSourceViewOutput(invoke('status', roots[0]!).stdout, actual), null);
    const empty = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/ls', '-A', roots[0]!]);
    assert.equal(empty.stdout, '');
    const first = invoke('materialize', roots[0]!);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(parseWslSourceViewOutput(first.stdout, actual)?.kind, 'ready');
    const contents = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/cat',
      `${roots[0]}/${actual.attemptId}.view/src/a.ts`]);
    assert.equal(contents.stdout, 'selected bytes\n');
    const loseLock = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/rm',
      `${roots[0]}/${actual.attemptId}.lock`]);
    assert.equal(loseLock.status, 0, loseLock.stderr);
    assert.notEqual(invoke('status', roots[0]!).status, 0);
    assert.equal(invoke('materialize', roots[0]!).status, 0);
    const extra = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,sys; open(sys.argv[1]+"/"+sys.argv[2]+".view/src/extra.ts","wb").write(b"extra")', roots[0]!, actual.attemptId]);
    assert.equal(extra.status, 0, extra.stderr);
    assert.notEqual(invoke('status', roots[0]!).status, 0);
    assert.notEqual(invoke('materialize', roots[0]!).status, 0);
    const removeExtra = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,sys; os.unlink(sys.argv[1]+"/"+sys.argv[2]+".view/src/extra.ts")', roots[0]!, actual.attemptId]);
    assert.equal(removeExtra.status, 0, removeExtra.stderr);
    const changed = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,sys; p=sys.argv[1]+"/"+sys.argv[2]+".view/src/a.ts"; os.chmod(p,0o600); open(p,"wb").write(b"changed")', roots[0]!, actual.attemptId]);
    assert.equal(changed.status, 0, changed.stderr);
    assert.notEqual(invoke('status', roots[0]!).status, 0);
    const restore = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,sys; p=sys.argv[1]+"/"+sys.argv[2]+".view/src/a.ts"; open(p,"wb").write(b"selected bytes\\n"); os.chmod(p,0o400)', roots[0]!, actual.attemptId]);
    assert.equal(restore.status, 0, restore.stderr);
    const loseState = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,sys; os.unlink(sys.argv[1]+"/"+sys.argv[2]+".json")', roots[0]!, actual.attemptId]);
    assert.equal(loseState.status, 0, loseState.stderr);
    assert.notEqual(invoke('status', roots[0]!).status, 0);
    const wrongs = [
      { ...actual, workspaceId: `ws_22222222-2222-4222-8222-222222222222` },
      { ...actual, workerEpoch: 2 },
      { ...actual, sourceDigest: '2'.repeat(64) },
    ];
    for (const wrong of wrongs) assert.notEqual(invoke('close', roots[0]!, wrong).status, 0);
    const stillThere = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/cat',
      `${roots[0]}/${actual.attemptId}.view/src/a.ts`]);
    assert.equal(stillThere.stdout, 'selected bytes\n');
    const markerPath = `${roots[0]}/${actual.attemptId}.view/.source-view.json`;
    const markerBackup = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/cat', markerPath]);
    assert.equal(markerBackup.status, 0, markerBackup.stderr);
    const loseMarker = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/rm', markerPath]);
    assert.equal(loseMarker.status, 0, loseMarker.stderr);
    assert.notEqual(invoke('close', roots[0]!).status, 0);
    const noTombstone = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,sys; print(os.path.lexists(sys.argv[1]))', `${roots[0]}/${actual.attemptId}.json`]);
    assert.equal(noTombstone.stdout.trim(), 'False');
    const restoreMarker = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,sys; p=sys.argv[1]; open(p,"wb").write(sys.stdin.buffer.read()); os.chmod(p,0o400)', markerPath], markerBackup.stdout);
    assert.equal(restoreMarker.status, 0, restoreMarker.stderr);
    const stagingName = `${actual.attemptId}.${'a'.repeat(32)}.staging`;
    const orphan = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/mkdir', '-m', '700',
      `${roots[0]}/${stagingName}`]);
    assert.equal(orphan.status, 0, orphan.stderr);
    assert.notEqual(invoke('materialize', roots[0]!).status, 0);
    assert.notEqual(invoke('close', roots[0]!).status, 0);
    const stageGone = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,sys; print(os.path.lexists(sys.argv[1]))', `${roots[0]}/${stagingName}`]);
    assert.equal(stageGone.stdout.trim(), 'True');
    const removeUnknownStage = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/rmdir',
      `${roots[0]}/${stagingName}`]);
    assert.equal(removeUnknownStage.status, 0, removeUnknownStage.stderr);
    assert.equal(invoke('materialize', roots[0]!).status, 0);
    const boundStage = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,shutil,sys; r,a,s=sys.argv[1:]; d=r+"/"+s; os.mkdir(d,0o700); shutil.copyfile(r+"/"+a+".view/.source-view.json",d+"/.source-view.json"); os.chmod(d+"/.source-view.json",0o400)',
      roots[0]!, actual.attemptId, stagingName]);
    assert.equal(boundStage.status, 0, boundStage.stderr);
    assert.equal(invoke('materialize', roots[0]!).status, 0);
    const boundGone = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,sys; print(os.path.lexists(sys.argv[1]))', `${roots[0]}/${stagingName}`]);
    assert.equal(boundGone.stdout.trim(), 'False');
    const tamper = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,sys; r,a=sys.argv[1:]; open(r+"/sibling","wb").write(b"keep"); p=r+"/"+a+".view/src/a.ts"; os.unlink(p); os.symlink(r+"/sibling",p)', roots[0]!, actual.attemptId]);
    assert.equal(tamper.status, 0, tamper.stderr);
    assert.notEqual(invoke('materialize', roots[0]!).status, 0);
    assert.notEqual(invoke('close', roots[0]!).status, 0);
    const afterRejectedClose = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/cat',
      `${roots[0]}/${actual.attemptId}.json`]);
    assert.equal(JSON.parse(afterRejectedClose.stdout).kind, 'ready');
    const removeLink = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,sys; os.unlink(sys.argv[1]+"/"+sys.argv[2]+".view/src/a.ts")', roots[0]!, actual.attemptId]);
    assert.equal(removeLink.status, 0, removeLink.stderr);
    const restoreAfterLink = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,sys; p=sys.argv[1]+"/"+sys.argv[2]+".view/src/a.ts"; open(p,"wb").write(b"selected bytes\\n"); os.chmod(p,0o400)', roots[0]!, actual.attemptId]);
    assert.equal(restoreAfterLink.status, 0, restoreAfterLink.stderr);
    const closed = invoke('close', roots[0]!);
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(parseWslSourceViewOutput(closed.stdout, actual)?.kind, 'closed');
    const missingView = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,sys; print(os.path.lexists(sys.argv[1]+"/"+sys.argv[2]+".view"))', roots[0]!, actual.attemptId]);
    assert.equal(missingView.stdout.trim(), 'False');
    assert.notEqual(invoke('materialize', roots[0]!).status, 0);
    const sibling = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/cat', `${roots[0]}/sibling`]);
    assert.equal(sibling.stdout, 'keep');
    const oldBoot = { ...actual, bootId: '33333333-3333-4333-8333-333333333333' };
    assert.equal(invoke('close', roots[1]!).status, 0);
    const removeState = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/rm',
      `${roots[1]}/${actual.attemptId}.json`]);
    assert.equal(removeState.status, 0, removeState.stderr);
    const fifo = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/mkfifo',
      `${roots[1]}/${actual.attemptId}.json`]);
    assert.equal(fifo.status, 0, fifo.stderr);
    const fifoStatus = invoke('status', roots[1]!, actual, 3_000);
    assert.notEqual(fifoStatus.status, 0);
    assert.notEqual((fifoStatus.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT');
    const removeFifo = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/rm',
      `${roots[1]}/${actual.attemptId}.json`]);
    assert.equal(removeFifo.status, 0, removeFifo.stderr);
    assert.equal(invoke('close', roots[1]!, oldBoot).status, 0);
    assert.notEqual(invoke('materialize', roots[1]!).status, 0);
    assert.equal(invoke('materialize', roots[2]!).status, 0);
    const simulatedReboot = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      `import json,os,sys
r,a,b=sys.argv[1:]
paths=[r+'/'+a+'.json',r+'/'+a+'.view/.source-view.json']
for p in paths:
    with open(p) as source: value=json.load(source)
    value['bootId']=b
    os.chmod(p,0o600)
    with open(p,'w') as target: json.dump(value,target)
os.chmod(paths[1],0o400)`,
      roots[2]!, actual.attemptId, oldBoot.bootId]);
    assert.equal(simulatedReboot.status, 0, simulatedReboot.stderr);
    assert.notEqual(invoke('status', roots[2]!, oldBoot).status, 0);
    assert.equal(invoke('close', roots[2]!, oldBoot).status, 0);
    assert.equal(invoke('materialize', roots[3]!).status, 0);
    const prematureMissing = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/rm',
      `${roots[3]}/${actual.attemptId}.view/src/a.ts`]);
    assert.equal(prematureMissing.status, 0, prematureMissing.stderr);
    assert.notEqual(invoke('close', roots[3]!).status, 0);
    const stillReady = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/cat',
      `${roots[3]}/${actual.attemptId}.json`]);
    assert.equal(JSON.parse(stillReady.stdout).kind, 'ready');
    const partialCrash = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      `import json,os,sys
r,a=sys.argv[1:]
p=r+'/'+a+'.json'
with open(p) as source: state=json.load(source)
state['kind']='closed'
with open(p,'w') as target: json.dump(state,target)`, roots[3]!, actual.attemptId]);
    assert.equal(partialCrash.status, 0, partialCrash.stderr);
    assert.equal(invoke('close', roots[3]!).status, 0);
    assert.equal(invoke('status', roots[3]!).status, 0);
    assert.equal(invoke('materialize', roots[4]!).status, 0);
    const markerlessCrash = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      `import json,os,sys
r,a=sys.argv[1:]
p=r+'/'+a+'.json'
with open(p) as source: state=json.load(source)
state['kind']='closed'
with open(p,'w') as target: json.dump(state,target)
os.unlink(r+'/'+a+'.view/src/a.ts')
os.rmdir(r+'/'+a+'.view/src')
os.unlink(r+'/'+a+'.view/.source-view.json')`, roots[4]!, actual.attemptId]);
    assert.equal(markerlessCrash.status, 0, markerlessCrash.stderr);
    assert.equal(invoke('close', roots[4]!).status, 0);
    const emptyStageName = `${actual.attemptId}.${'b'.repeat(32)}.staging`;
    const emptyStage = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/mkdir', '-m', '700',
      `${roots[4]}/${emptyStageName}`]);
    assert.equal(emptyStage.status, 0, emptyStage.stderr);
    assert.equal(invoke('close', roots[4]!).status, 0);
    const unexpectedStage = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
      'import os,sys; p=sys.argv[1]; os.mkdir(p,0o700); open(p+"/foreign","wb").write(b"preserve")',
      `${roots[4]}/${emptyStageName}`]);
    assert.equal(unexpectedStage.status, 0, unexpectedStage.stderr);
    assert.notEqual(invoke('close', roots[4]!).status, 0);
    const preserved = run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/cat',
      `${roots[4]}/${emptyStageName}/foreign`]);
    assert.equal(preserved.stdout, 'preserve');
  } finally {
    for (const rootPath of roots) {
      assert.match(rootPath, new RegExp(`^/home/${linuxUser}/\\.rcac-source-view-test-[A-Za-z0-9]+$`));
      run(['-d', distro, '--user', linuxUser, '--exec', '/usr/bin/python3', '-I', '-S', '-c',
        'import shutil,sys; shutil.rmtree(sys.argv[1])', rootPath]);
    }
  }
});
