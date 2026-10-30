import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve('tools/verify-release.mjs');
const template = JSON.parse(readFileSync(resolve('verification/RUNTIME_ACCEPTANCE.json'), 'utf8'));
const evidenceSchema = readFileSync(resolve('verification/evidence-record.schema.json'));
const commands = ['typecheck', 'lint', 'test', 'test:contracts', 'test:integration', 'test:faults',
  'test:security', 'test:boundary', 'test:e2e:mock', 'build', 'package:smoke'];
const expectedScripts = {
  test: 'tsx --test --test-concurrency=2 tests/**/*.test.ts',
  'test:contracts': 'tsx --test tests/contracts/*.test.ts',
  'test:integration': 'tsx --test --test-concurrency=2 tests/integration/*.test.ts',
  'test:faults': 'tsx --test tests/faults/*.test.ts',
  'test:security': 'tsx --test tests/security/*.test.ts',
  'test:boundary': 'tsx --test tests/boundary/*.test.ts',
  'test:e2e:mock': 'tsx --test tests/e2e/*.mock.test.ts',
};

function fixture(packageScripts: Record<string, string> = expectedScripts) {
  const root = mkdtempSync(join(tmpdir(), 'rcac-release-test-'));
  const put = (path: string, value: unknown) => {
    const target = join(root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  };
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init']);
  put('package.json', { name: 'fixture', version: '1.0.0', scripts: packageScripts });
  put('verification/evidence-record.schema.json', evidenceSchema);
  git(['add', 'package.json', 'verification/evidence-record.schema.json']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  const build = 'build-fixture-1';
  const acceptance = structuredClone(template);
  acceptance.status = 'passed';
  acceptance.generated_by = 'local-verification-runner';
  acceptance.source_commit = commit;
  acceptance.build_id = build;
  acceptance.platform = 'synthetic-test-platform';
  acceptance.account_ref = 'synthetic-account';
  acceptance.capabilities_verified = true;
  acceptance.effective_collection_route = 'native_file_reference';
  acceptance.blockers = [];
  const archive = Buffer.from('synthetic package archive bytes');
  const packageSha256 = createHash('sha256').update(archive).digest('hex');
  const packageIntegrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
  const archiveRef = 'verification/logs/package-fixture.tgz';
  const outputRef = 'verification/logs/package-smoke.stdout';
  put(archiveRef, archive);
  put(outputRef, 'package smoke startup\n' + JSON.stringify({ status: 'passed', packageSha256, packageIntegrity }) + '\n');
  acceptance.release_artifact = { archive_ref: archiveRef, sha256: packageSha256, integrity: packageIntegrity };
  const record = (name: string, extra: Record<string, unknown> = {}) => {
    const log = `verification/logs/${name}.log`;
    put(log, `fixture observation ${name}\n`);
    const path = `verification/receipts/${name}.json`;
    const packagePurpose = extra.case_id === 'PACKAGE01' || extra.case_id === 'AC14' && extra.layer === 'package_smoke' ||
      extra.case_id === 'offline:package:smoke';
    put(path, { schema_version: '0.2', run_id: `${name}-fixture`, status: 'passed',
      source_commit: commit, build_id: build,
      started_at: '2026-09-27T00:00:00Z', finished_at: '2026-09-27T00:01:00Z',
      executor: 'synthetic-fixture', command: `fixture ${name}`, cwd: root, exit_code: 0,
      observations: [{ assertion: name, observed: 'fixture passed', evidence_refs: [log] }],
      evidence_refs: packagePurpose ? [log, outputRef] : [log], blockers: [],
      ...(packagePurpose ? { package_artifact: {
        archive_ref: archiveRef, sha256: packageSha256, integrity: packageIntegrity },
        package_smoke_output_ref: outputRef } : {}), ...extra });
    return path;
  };
  const delivery = (runId: string, role: string, bundleId: string,
    parentBundleId: string | null, files: Array<{ path: string; bytes: Buffer; mediaType: string; sourceReceipt: string }>) => {
    const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const fileRefs = files.map((file, index) => {
      const evidenceRef = `verification/live/${runId}/${bundleId}/file-${index}`;
      put(evidenceRef, file.bytes);
      return { normalized_relative_path: file.path, evidence_ref: evidenceRef };
    });
    const manifest = { bundleId, workspaceId: runId === 'LIVE02' ? 'ws-b' : 'ws-a',
      collaborationId: runId === 'LIVE02' ? 'col-c2' : 'col-c1', contextRevision: 'ctx-fixture',
      snapshotRefs: ['snapshot-fixture'], ...(parentBundleId ? { parentBundleId } : {}),
      expectedPaths: files.map((file) => file.path), expectedSetBasis: 'producer_declared',
      semanticStatus: 'not_reviewed',
      files: files.map((file) => ({ normalizedRelativePath: file.path,
        actualSizeBytes: file.bytes.length, sha256: sha256(file.bytes),
        mediaType: file.mediaType, sourceReceipt: file.sourceReceipt })) };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const manifestRef = `verification/live/${runId}/${bundleId}/manifest.json`;
    put(manifestRef, manifestBytes);
    return { role, manifest_ref: manifestRef, manifest_hash: sha256(manifestBytes), file_refs: fileRefs };
  };
  const text = (path: string, content: string) =>
    ({ path, bytes: Buffer.from(content), mediaType: 'text/plain', sourceReceipt: 'text_set_mcp' });
  const live01v1 = delivery('LIVE01', 'v1', 'bundle-c1-v1', null, [
    text('report.md', '# Report'), text('report.html', '<h1>Report</h1>'),
    { ...text('data.json', '{}'), mediaType: 'application/json' },
    { path: 'nested/result.bin', bytes: Buffer.from([0, 1, 2, 3]),
      mediaType: 'application/octet-stream', sourceReceipt: 'platform_file_reference' },
  ]);
  const live01v2 = delivery('LIVE01', 'v2', 'bundle-c1-v2', 'bundle-c1-v1', [
    text('report.md', '# Revision'), text('notes.md', 'Updated'),
  ]);
  const live02 = delivery('LIVE02', 'independent', 'bundle-c2-v1', null, [
    text('report.md', '# Independent'), text('notes.md', 'Evidence'),
  ]);
  for (const [name, stage] of Object.entries(acceptance.stages) as
    [string, { status: string; evidence_refs: string[] }][]) {
    stage.status = 'passed';
    stage.evidence_refs = [record(`stage-${name}`, { case_id: `stage:${name}`, layer: 'review' })];
  }
  for (const ac of acceptance.acceptance_cases) {
    for (const [layer, entry] of Object.entries(ac.layers) as [string, { status: string; evidence_refs: string[] }][]) {
      entry.status = 'passed';
      entry.evidence_refs = [record(`${ac.id}-${layer}`, { case_id: ac.id, layer,
        actual_human_performed: layer === 'live_human',
        runtime_versions: layer.startsWith('live') || layer === 'real_second_runtime' ? { client: 'fixture' } : {} })];
    }
  }
  for (const run of acceptance.live_runs) {
    run.status = 'passed'; run.run_id = `${run.id}-fixture`;
    run.evidence_refs = [record(run.id, { case_id: run.id, run_id: run.run_id,
      layer: run.id === 'NEUTRAL01' ? 'real_second_runtime' : 'live', runtime_versions: { client: 'fixture' },
      ...(run.id === 'LIVE01' ? { route: 'native_file_reference', bundle_deliveries: [live01v1, live01v2] } : {}),
      ...(run.id === 'LIVE02' ? { route: 'text_set_mcp', bundle_deliveries: [live02] } : {}) })];
  }
  acceptance.human_handoff = { status: 'passed', actual_human_performed: true,
    evidence_refs: [record('human', { case_id: 'AC02', layer: 'live_human', actual_human_performed: true,
      runtime_versions: { client: 'fixture' } })] };
  acceptance.model_loading = { status: 'passed', evidence_record: record('model-loading',
    { case_id: 'release:model_loading', layer: 'review' }) };
  acceptance.clean_package_smoke = { status: 'passed', evidence_refs: [record('package', { case_id: 'PACKAGE01', layer: 'package_smoke' })] };
  const offline_commands = Object.fromEntries(commands.map((name) => [name, { status: 'passed',
    evidence_refs: [record(`offline-${name.replaceAll(':', '-')}`,
      { case_id: `offline:${name}`, layer: 'offline_command', command: `npm run ${name}` })] }]));
  acceptance.release_evidence = {
    offline_commands,
    license_review: { status: 'passed', evidence_refs: [record('license',
      { case_id: 'release:license_review', layer: 'review' })] },
    secret_scan: { status: 'passed', evidence_refs: [record('secrets',
      { case_id: 'release:secret_scan', layer: 'review' })] },
    safety_defects: { status: 'passed', unresolved_critical: [], evidence_refs: [record('safety',
      { case_id: 'release:safety_defects', layer: 'review' })] },
    capability_report: { status: 'passed', evidence_refs: [record('capability',
      { case_id: 'release:capability_report', layer: 'review' })],
      report_ref: 'work/capability-matrix.json' },
  };
  put('work/capability-matrix.json', { source_commit: commit, build_id: build,
    account_ref: acceptance.account_ref, observed_at: '2026-09-27T00:00:00Z',
    overall_status: 'verified', capabilities: [
      'mcp.chatgpt_remote', 'conversation.send', 'conversation.read_history_delta',
      'conversation.user_handoff', 'repository.pull', 'investigation.submit',
      'investigation.observe', 'investigation.readonly_isolation', 'artifact.accept_native_reference',
    ].map((id) => ({ id, status: 'supported',
      evidence_refs: ['verification/receipts/AC01-contracts.json'] })) });
  const save = () => put('verification/RUNTIME_ACCEPTANCE.json', acceptance);
  const run = () => spawnSync(process.execPath, [script, '--root', root],
    { encoding: 'utf8', timeout: 30_000 });
  save();
  git(['add', '--', 'verification/RUNTIME_ACCEPTANCE.json', 'verification/receipts',
    'verification/logs', 'verification/live', 'work/capability-matrix.json']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'Archive synthetic evidence']);
  return { root, acceptance, put, save, run, git, commit, build };
}

test('release verifier accepts a complete synthetic receipt graph only in a temporary fixture', () => {
  const f = fixture();
  try { assert.equal(f.run().status, 0, f.run().stderr); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('package gates require one declared archive and matching identity in every receipt', () => {
  for (const target of ['package', 'AC14-package_smoke', 'offline-package-smoke']) {
    for (const defect of ['missing_receipt', 'missing_identity', 'unknown_identity',
      'bad_hash', 'bad_integrity', 'array_hash', 'array_integrity',
      'other_archive', 'missing_output_ref', 'output_not_listed']) {
      const f = fixture();
      try {
        const path = `verification/receipts/${target}.json`;
        const receipt = JSON.parse(readFileSync(join(f.root, path), 'utf8'));
        if (defect === 'missing_receipt') delete receipt.package_artifact;
        else if (defect === 'missing_identity') delete receipt.package_artifact.sha256;
        else if (defect === 'unknown_identity') receipt.package_artifact.unexpected = true;
        else if (defect === 'bad_hash') receipt.package_artifact.sha256 = '0'.repeat(64);
        else if (defect === 'bad_integrity') receipt.package_artifact.integrity = 'sha512-bad';
        else if (defect === 'array_hash') receipt.package_artifact.sha256 = [receipt.package_artifact.sha256];
        else if (defect === 'array_integrity') receipt.package_artifact.integrity = [receipt.package_artifact.integrity];
        else if (defect === 'other_archive') {
          const bytes = Buffer.from('another self-consistent archive');
          f.put('verification/logs/other.tgz', bytes);
          receipt.package_artifact = { ...receipt.package_artifact,
            archive_ref: 'verification/logs/other.tgz',
            sha256: createHash('sha256').update(bytes).digest('hex'),
            integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
        } else if (defect === 'missing_output_ref') delete receipt.package_smoke_output_ref;
        else receipt.evidence_refs = receipt.evidence_refs.filter((ref: string) =>
          ref !== receipt.package_smoke_output_ref);
        f.put(path, receipt);
        const result = f.run();
        assert.notEqual(result.status, 0, `${target}/${defect}`);
        assert.match(result.stderr, /package_artifact|package smoke output|release_artifact/i,
          `${target}/${defect}`);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }
  }
});

test('package gate validates every receipt, including a second conflicting archive', () => {
  const f = fixture();
  try {
    const original = JSON.parse(readFileSync(join(f.root, 'verification/receipts/package.json'), 'utf8'));
    const bytes = Buffer.from('second archive');
    f.put('verification/logs/second-package.tgz', bytes);
    const second = { ...original, run_id: 'second-package-run',
      package_artifact: { ...original.package_artifact,
        archive_ref: 'verification/logs/second-package.tgz',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') } };
    f.put('verification/receipts/package-second.json', second);
    f.acceptance.clean_package_smoke.evidence_refs.push('verification/receipts/package-second.json');
    f.save();
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /clean_package_smoke\.evidence_refs\[1\].*package_artifact/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('package gate rejects missing or malformed target declaration', () => {
  for (const defect of ['missing', 'unknown', 'hash', 'integrity', 'array_hash', 'array_integrity']) {
    const f = fixture();
    try {
      if (defect === 'missing') delete f.acceptance.release_artifact;
      else if (defect === 'unknown') f.acceptance.release_artifact.unexpected = true;
      else if (defect === 'hash') f.acceptance.release_artifact.sha256 = 'bad';
      else if (defect === 'array_hash') f.acceptance.release_artifact.sha256 = [f.acceptance.release_artifact.sha256];
      else if (defect === 'array_integrity') f.acceptance.release_artifact.integrity = [f.acceptance.release_artifact.integrity];
      else f.acceptance.release_artifact.integrity = 'sha512-bad';
      f.save();
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /acceptance\.release_artifact/i);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('package gate rejects archive byte changes, missing file and oversize', () => {
  for (const defect of ['changed', 'missing', 'oversize']) {
    const f = fixture();
    try {
      const path = join(f.root, 'verification/logs/package-fixture.tgz');
      if (defect === 'changed') writeFileSync(path, 'altered archive');
      else if (defect === 'missing') rmSync(path);
      else if (defect === 'oversize') writeFileSync(path, Buffer.alloc(32 * 1024 * 1024 + 1));
      const result = f.run();
      assert.notEqual(result.status, 0, defect);
      assert.match(result.stderr, /release_artifact|archive|package_artifact/i, defect);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('package gate rejects a linked archive', (t) => {
  const f = fixture();
  try {
    const path = join(f.root, 'verification/logs/package-fixture.tgz');
    rmSync(path);
    try { symlinkSync(join(f.root, 'package.json'), path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Windows account cannot create file symlinks (EPERM)');
        return;
      }
      throw error;
    }
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release_artifact|archive|symbolic link/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('package gate requires one final machine output bound to archive bytes', () => {
  for (const output of ['', 'plain passed text\n', '{"status":"passed"}\n',
    '{"status":"passed","packageSha256":\n',
    '{"status":"passed","packageSha256":"bad","packageIntegrity":"bad"}\n',
    '{"status":"passed","packageSha256":"bad","packageIntegrity":"bad","unknown":true}\n',
    '{"status":"passed","packageSha256":"bad","packageIntegrity":"bad"}\n{"status":"passed","packageSha256":"bad","packageIntegrity":"bad"}\n']) {
    const f = fixture();
    try {
      f.put('verification/logs/package-smoke.stdout', output);
      const result = f.run();
      assert.notEqual(result.status, 0, output);
      assert.match(result.stderr, /package smoke output|package_artifact|package_smoke_output_ref/i, output);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('package gate accepts installed Host Skill metadata in the final smoke result', () => {
  const f = fixture();
  try {
    const outputRef = 'verification/logs/package-smoke.stdout';
    const original = readFileSync(join(f.root, outputRef), 'utf8').trim().split('\n').at(-1);
    const result = JSON.parse(original!);
    result.installedHostSkillFiles = [
      'skills/consult-external-agent/SKILL.md',
      'skills/consult-external-agent/agents/openai.yaml',
      'skills/consult-external-agent/references/commands.md',
    ].map((path, index) => ({ path, bytes: index + 1, sha256: 'a'.repeat(64) }));
    f.put(outputRef, `package smoke startup\n${JSON.stringify(result)}\n`);
    const verification = f.run();
    assert.equal(verification.status, 0, verification.stderr);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('package gate rejects malformed installed Host Skill metadata and adjacent unknown fields', () => {
  const paths = [
    'skills/consult-external-agent/SKILL.md',
    'skills/consult-external-agent/agents/openai.yaml',
    'skills/consult-external-agent/references/commands.md',
  ];
  const validFiles = () => paths.map((path, index) =>
    ({ path, bytes: index + 1, sha256: 'a'.repeat(64) }));
  const defects: Array<[string, unknown, Record<string, unknown> | undefined]> = [
    ['not_array', {}, undefined],
    ['missing_file', validFiles().slice(0, 2), undefined],
    ['duplicate_path', [validFiles()[0], validFiles()[0], validFiles()[2]], undefined],
    ['wrong_path', validFiles().map((file, index) => index === 1 ? { ...file, path: 'wrong' } : file), undefined],
    ['missing_bytes', validFiles().map((file, index) => index === 1 ? { path: file.path, sha256: file.sha256 } : file), undefined],
    ['missing_hash', validFiles().map((file, index) => index === 1 ? { path: file.path, bytes: file.bytes } : file), undefined],
    ['extra_file_field', validFiles().map((file, index) => index === 1 ? { ...file, extra: true } : file), undefined],
    ['zero_bytes', validFiles().map((file, index) => index === 1 ? { ...file, bytes: 0 } : file), undefined],
    ['string_bytes', validFiles().map((file, index) => index === 1 ? { ...file, bytes: '1' } : file), undefined],
    ['fractional_bytes', validFiles().map((file, index) => index === 1 ? { ...file, bytes: 1.5 } : file), undefined],
    ['unsafe_bytes', validFiles().map((file, index) => index === 1 ? { ...file, bytes: Number.MAX_SAFE_INTEGER + 1 } : file), undefined],
    ['short_hash', validFiles().map((file, index) => index === 1 ? { ...file, sha256: 'a'.repeat(63) } : file), undefined],
    ['uppercase_hash', validFiles().map((file, index) => index === 1 ? { ...file, sha256: 'A'.repeat(64) } : file), undefined],
    ['unknown_neighbor', validFiles(), { unexpectedSmokeField: true }],
  ];
  for (const [name, files, extra] of defects) {
    const f = fixture();
    try {
      const outputRef = 'verification/logs/package-smoke.stdout';
      const original = readFileSync(join(f.root, outputRef), 'utf8').trim().split('\n').at(-1);
      const result = { ...JSON.parse(original!), installedHostSkillFiles: files, ...extra };
      f.put(outputRef, `package smoke startup\n${JSON.stringify(result)}\n`);
      const verification = f.run();
      assert.notEqual(verification.status, 0, `${name}: ${verification.stderr}`);
      assert.match(verification.stderr, /package smoke output/i, name);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('receipt contract rejects missing identity metadata and unknown top-level fields', () => {
  const f = fixture();
  const path = 'verification/receipts/license.json';
  try {
    const original = JSON.parse(readFileSync(join(f.root, path), 'utf8'));
    for (const [field, value] of [
      ['schema_version', undefined], ['schema_version', '0.1'],
      ['run_id', undefined], ['run_id', '  '],
      ['case_id', undefined], ['layer', undefined], ['unexpected_grant', true],
    ] as const) {
      const changed = { ...original };
      if (value === undefined) delete changed[field];
      else changed[field] = value;
      f.put(path, changed);
      const result = f.run();
      assert.notEqual(result.status, 0, `${field}=${value}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`license_review.*${field}`), `${field}=${value}`);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('receipt contract rejects wrong review purpose and unknown case or layer', () => {
  const f = fixture();
  const path = 'verification/receipts/license.json';
  try {
    const original = JSON.parse(readFileSync(join(f.root, path), 'utf8'));
    for (const [caseId, layer, diagnostic] of [
      ['release:secret_scan', 'review', /license_review.*case_id/],
      ['AC01', 'contracts', /license_review.*case_id/],
      ['release:unlisted', 'review', /license_review.*case_id/],
      ['release:license_review', 'live', /license_review.*layer/],
      ['release:license_review', 'invented', /license_review.*layer/],
    ] as const) {
      f.put(path, { ...original, case_id: caseId, layer });
      const result = f.run();
      assert.notEqual(result.status, 0, `${caseId}/${layer}: ${result.stderr}`);
      assert.match(result.stderr, diagnostic, `${caseId}/${layer}`);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('receipt contract rejects stage substitution and review receipts in live gates', () => {
  const f = fixture();
  try {
    const stagePath = 'verification/receipts/stage-core_verified.json';
    const stage = JSON.parse(readFileSync(join(f.root, stagePath), 'utf8'));
    f.put(stagePath, { ...stage, case_id: 'stage:release_ready' });
    let result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stages\.core_verified.*case_id/);
    f.put(stagePath, { ...stage, layer: 'contracts' });
    result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stages\.core_verified.*layer/);
    f.put(stagePath, stage);

    const livePath = 'verification/receipts/AC01-live.json';
    const live = JSON.parse(readFileSync(join(f.root, livePath), 'utf8'));
    f.put(livePath, { ...live, case_id: 'release:license_review', layer: 'review' });
    result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AC01\.live.*(?:case_id|layer)/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('receipt contract binds offline case and command independently', () => {
  const f = fixture();
  const path = 'verification/receipts/offline-typecheck.json';
  try {
    const original = JSON.parse(readFileSync(join(f.root, path), 'utf8'));
    f.put(path, { ...original, case_id: 'offline:lint' });
    let result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /offline_commands\.typecheck.*case_id/);
    f.put(path, { ...original, command: 'npm run lint' });
    result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /offline_commands\.typecheck.*command/);
    f.put(path, { ...original, layer: 'review' });
    result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /offline_commands\.typecheck.*layer/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('receipt contract rejects model loading certified by a license review', () => {
  const f = fixture();
  try {
    f.acceptance.model_loading.evidence_record = 'verification/receipts/license.json';
    f.save();
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /model_loading.*case_id/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const [kind, receiptPath] of [
  ['license review', 'verification/receipts/license.json'],
  ['stage review', 'verification/receipts/stage-core_verified.json'],
  ['offline command', 'verification/receipts/offline-typecheck.json'],
] as const) test(`capability execution receipt rejects ${kind} substitution`, () => {
  const f = fixture();
  try {
    const path = 'work/capability-matrix.json';
    const report = JSON.parse(readFileSync(join(f.root, path), 'utf8'));
    report.capabilities.find((item: { id: string }) => item.id === 'mcp.chatgpt_remote')
      .evidence_refs = [receiptPath];
    f.put(path, report);
    const result = f.run();
    assert.notEqual(result.status, 0, `${kind}: ${result.stderr}`);
    assert.match(result.stderr, /capability_report\.mcp\.chatgpt_remote.*execution/i, kind);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('capability execution receipt accepts actual AC, LIVE and NEUTRAL references', () => {
  const f = fixture();
  try {
    const path = 'work/capability-matrix.json';
    const original = JSON.parse(readFileSync(join(f.root, path), 'utf8'));
    for (const receiptPath of [
      'verification/receipts/AC01-contracts.json',
      'verification/receipts/LIVE01.json',
      'verification/receipts/NEUTRAL01.json',
    ]) {
      const report = structuredClone(original);
      report.capabilities.find((item: { id: string }) => item.id === 'mcp.chatgpt_remote')
        .evidence_refs = [receiptPath];
      f.put(path, report);
      const result = f.run();
      assert.equal(result.status, 0, `${receiptPath}: ${result.stderr}`);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('release verifier rejects missing evidence and stale build binding', () => {
  const f = fixture();
  try {
    f.acceptance.acceptance_cases[0].layers.live.evidence_refs = [];
    f.save();
    let result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AC01\.live.*evidence/i);
    f.acceptance.acceptance_cases[0].layers.live.evidence_refs = ['verification/receipts/AC01-live.json'];
    const path = 'verification/receipts/AC01-live.json';
    const receipt = JSON.parse(readFileSync(join(f.root, path), 'utf8'));
    f.put(path, { ...receipt, build_id: 'older-build' });
    f.save();
    result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AC01\.live.*build/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('release verifier rejects simulated handoff, blocked runtime and safety defect', () => {
  const f = fixture();
  try {
    f.acceptance.human_handoff.actual_human_performed = false;
    f.acceptance.live_runs.find((run: { id: string }) => run.id === 'NEUTRAL01').status = 'blocked';
    f.acceptance.release_evidence.safety_defects.unresolved_critical = ['cross-project disclosure'];
    f.save();
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /human_handoff.*actual_human_performed/i);
    assert.match(result.stderr, /NEUTRAL01.*blocked/i);
    assert.match(result.stderr, /unresolved_critical/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('release verifier rejects absent offline command receipt and unsupported collection route', () => {
  const f = fixture();
  try {
    delete f.acceptance.release_evidence.offline_commands['test:security'];
    f.acceptance.effective_collection_route = 'manual_import';
    f.save();
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /test:security/i);
    assert.match(result.stderr, /effective_collection_route/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('single_run accepts one complete test receipt without six undeclared subset runs',
  { timeout: 30_000 }, () => {
  const f = fixture();
  try {
    f.acceptance.release_evidence.offline_test_mode = 'single_run';
    for (const command of commands.filter(name => name.startsWith('test:')))
      delete f.acceptance.release_evidence.offline_commands[command];
    f.save();
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    for (const command of commands.filter(name => name.startsWith('test:')))
      f.acceptance.release_evidence.offline_commands[command] = { status: 'passed',
        evidence_refs: [`verification/receipts/offline-${command.replaceAll(':', '-')}.json`] };
    f.save();
    assert.equal(f.run().status, 0, 'single_run must also accept fully declared valid subsets');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('single_run rejects invalid mode, absent full test and invalid declared subset evidence',
  { timeout: 60_000 }, () => {
  const f = fixture();
  try {
    const release = f.acceptance.release_evidence;
    const offline = release.offline_commands;
    const path = 'verification/receipts/offline-test-security.json';
    const original = JSON.parse(readFileSync(join(f.root, path), 'utf8'));
    const fullPath = 'verification/receipts/offline-test.json';
    const originalFull = JSON.parse(readFileSync(join(f.root, fullPath), 'utf8'));
    for (const [mode, diagnostic] of [[null, /offline_test_mode/],
      ['narrow', /offline_test_mode/]] as const) {
      release.offline_test_mode = mode;
      f.save();
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, diagnostic);
    }
    release.offline_test_mode = 'single_run';
    const testEntry = offline.test;
    delete offline.test;
    f.save();
    let result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /offline_commands\.test.*missing/i);
    offline.test = testEntry;
    for (const [change, diagnostic] of [
      [{ case_id: 'offline:test:security' }, /offline_commands\.test.*case_id/],
      [{ layer: 'review' }, /offline_commands\.test.*layer/],
      [{ command: 'npm run test -- --test-name-pattern=small' }, /offline_commands\.test.*command/],
    ] as const) {
      f.put(fullPath, { ...originalFull, ...change });
      f.save();
      result = f.run();
      assert.notEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, diagnostic);
    }
    f.put(fullPath, originalFull);
    for (const [change, diagnostic] of [
      [{ case_id: 'offline:lint' }, /offline_commands\.test:security.*case_id/],
      [{ layer: 'review' }, /offline_commands\.test:security.*layer/],
      [{ command: 'npm run test' }, /offline_commands\.test:security.*command/],
      [{ source_commit: '0'.repeat(40) }, /offline_commands\.test:security.*source_commit/],
      [{ build_id: 'old-build' }, /offline_commands\.test:security.*build_id/],
    ] as const) {
      f.put(path, { ...original, ...change });
      f.save();
      result = f.run();
      assert.notEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, diagnostic);
    }
    f.put(path, original);
    offline['test:security'].status = 'failed';
    f.save();
    result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /offline_commands\.test:security.*failed/);
    offline['test:security'].status = 'passed';
    offline['test:extra'] = { status: 'passed', evidence_refs: [fullPath] };
    f.save();
    result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /offline_commands\.test:extra.*unknown command/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('single_run requires exact full and subset package scripts', { timeout: 45_000 }, () => {
  const changes = [
    ['test', 'tsx --test tests/**/*.test.ts'],
    ['test', 'tsx --test --test-concurrency=2 --test-name-pattern=small tests/**/*.test.ts'],
    ['test:integration', 'tsx --test --test-concurrency=2 tests/unit/*.test.ts'],
    ['test:security', 'tsx --test tests/**/*.test.ts'],
    ['test:contracts', 'tsx --test tests/contracts/*.test.ts && echo extra'],
  ] as const;
  for (const [name, value] of changes) {
    const f = fixture({ ...expectedScripts, [name]: value });
    try {
      f.acceptance.release_evidence.offline_test_mode = 'single_run';
      f.save();
      const result = f.run();
      assert.notEqual(result.status, 0, `${name}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`scripts\\.${name.replace(':', '\\:')}`), name);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('single_run still requires LIVE, human, NEUTRAL and package gates',
  { timeout: 40_000 }, () => {
  const f = fixture();
  try {
    f.acceptance.release_evidence.offline_test_mode = 'single_run';
    const checks: Array<[() => void, RegExp]> = [
      [() => { f.acceptance.acceptance_cases[0].layers.live.status = 'not_run'; }, /AC01\.live/],
      [() => { f.acceptance.human_handoff.actual_human_performed = false; }, /human_handoff/],
      [() => { f.acceptance.live_runs.find((run: { id: string }) => run.id === 'NEUTRAL01').status = 'blocked'; }, /NEUTRAL01/],
      [() => { f.acceptance.clean_package_smoke.status = 'not_run'; }, /clean_package_smoke/],
    ];
    const baseline = structuredClone(f.acceptance);
    for (const [breakGate, diagnostic] of checks) {
      Object.assign(f.acceptance, structuredClone(baseline));
      breakGate(); f.save();
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, diagnostic);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('single_run crash phase guard rejects hidden filtering only for npm test',
  { timeout: 45_000 }, () => {
  const args = ['--import', 'tsx', '--test', '--test-name-pattern', '^no crash tests match$',
    'tests/integration/installation-upgrade-crash.test.ts'];
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const run = (event: string, phase: string) => spawnSync(process.execPath, args, {
    cwd: resolve('.'), encoding: 'utf8', timeout: 15_000,
    env: { ...childEnv, npm_lifecycle_event: event, RCAC_CRASH_PHASE: phase },
  });
  for (const phase of ['', 'before_npm_spawn']) {
    const result = run('test', phase);
    assert.notEqual(result.status, 0, `${phase}: ${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /RCAC_CRASH_PHASE must not filter npm test/);
  }
  const diagnostic = run('test:integration', 'before_npm_spawn');
  assert.equal(diagnostic.status, 0, diagnostic.stderr);
});

test('release verifier rejects dirty product source and a live receipt from the mock layer', () => {
  const f = fixture();
  try {
    f.put('src/new-feature.ts', 'export const uncommitted = true;');
    const path = 'verification/receipts/AC01-live.json';
    const receipt = JSON.parse(readFileSync(join(f.root, path), 'utf8'));
    f.put(path, { ...receipt, layer: 'mock_e2e',
      observations: [{ assertion: 'mock', observed: 'mock only', evidence_refs: ['verification/logs/AC01-live.log'] }],
    });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release inputs differ from source commit/i);
    assert.match(result.stderr, /AC01\.live.*layer/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('release verifier rejects non-object acceptance, receipts, and capability reports', () => {
  const f = fixture();
  try {
    const receiptPath = 'verification/receipts/AC01-live.json';
    const originalReceipt = JSON.parse(readFileSync(join(f.root, receiptPath), 'utf8'));
    for (const bad of [null, [], 'invalid']) {
      const jsonValue = typeof bad === 'string' ? JSON.stringify(bad) : bad;
      f.put('verification/RUNTIME_ACCEPTANCE.json', jsonValue);
      assert.notEqual(f.run().status, 0);
      f.save();
      f.put(receiptPath, jsonValue);
      let result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /receipt must be a JSON object/);
      f.put(receiptPath, originalReceipt);
      f.put('work/capability-matrix.json', jsonValue);
      result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /report must be a JSON object/);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('text-only collection cannot satisfy the full release binary route', () => {
  const f = fixture();
  try {
    f.acceptance.effective_collection_route = 'text_set_mcp';
    f.save();
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /effective_collection_route/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('release verifier rejects a manual-only LIVE02 despite automatic LIVE01 delivery', () => {
  const f = fixture();
  try {
    const live = 'verification/receipts/LIVE02.json';
    const receipt = JSON.parse(readFileSync(join(f.root, live), 'utf8'));
    const item = receipt.bundle_deliveries[0];
    const manifest = JSON.parse(readFileSync(join(f.root, item.manifest_ref), 'utf8'));
    for (const file of manifest.files) file.sourceReceipt = 'manual_import';
    const bytes = Buffer.from(JSON.stringify(manifest));
    f.put(item.manifest_ref, bytes);
    item.manifest_hash = createHash('sha256').update(bytes).digest('hex');
    f.put(live, { ...receipt, route: 'manual_import' });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LIVE02.*automatic|LIVE02.*route/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('release verifier checks live bundle bytes, version parent and binary source route', () => {
  for (const defect of ['file_hash', 'parent', 'binary_route']) {
    const f = fixture();
    try {
      const live = 'verification/receipts/LIVE01.json';
      const receipt = JSON.parse(readFileSync(join(f.root, live), 'utf8'));
      const first = receipt.bundle_deliveries[0];
      const second = receipt.bundle_deliveries[1];
      if (defect === 'file_hash') f.put(first.file_refs[0].evidence_ref, '# corrupted');
      else {
        const target = defect === 'parent' ? second : first;
        const manifest = JSON.parse(readFileSync(join(f.root, target.manifest_ref), 'utf8'));
        if (defect === 'parent') manifest.parentBundleId = 'unrelated';
        else manifest.files.find((file: { normalizedRelativePath: string }) =>
          file.normalizedRelativePath === 'nested/result.bin').sourceReceipt = 'manual_import';
        const bytes = Buffer.from(JSON.stringify(manifest));
        f.put(target.manifest_ref, bytes);
        target.manifest_hash = createHash('sha256').update(bytes).digest('hex');
        f.put(live, receipt);
      }
      const result = f.run();
      assert.notEqual(result.status, 0, defect);
      assert.match(result.stderr, /LIVE01.*bundle|LIVE01.*binary|LIVE01.*parent|LIVE01.*file/i, defect);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('LIVE02 binary cannot substitute for the required LIVE01 v1 binary', () => {
  const f = fixture();
  try {
    for (const runId of ['LIVE01', 'LIVE02']) {
      const live = `verification/receipts/${runId}.json`;
      const receipt = JSON.parse(readFileSync(join(f.root, live), 'utf8'));
      const item = receipt.bundle_deliveries[0];
      const manifest = JSON.parse(readFileSync(join(f.root, item.manifest_ref), 'utf8'));
      const target = runId === 'LIVE01'
        ? manifest.files.find((file: { normalizedRelativePath: string }) =>
          file.normalizedRelativePath === 'nested/result.bin')
        : manifest.files.find((file: { normalizedRelativePath: string }) =>
          file.normalizedRelativePath === 'notes.md');
      target.mediaType = runId === 'LIVE01' ? 'text/plain' : 'application/octet-stream';
      target.sourceReceipt = runId === 'LIVE01' ? 'text_set_mcp' : 'platform_file_reference';
      const bytes = Buffer.from(JSON.stringify(manifest));
      f.put(item.manifest_ref, bytes);
      item.manifest_hash = createHash('sha256').update(bytes).digest('hex');
      f.put(live, receipt);
    }
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LIVE01\.bundle\.v1.*binary/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('text bytes and normalized text media types cannot satisfy LIVE01 binary proof', () => {
  for (const mediaType of ['TEXT/PLAIN', 'application/json; charset=utf-8', 'application/octet-stream']) {
    const f = fixture();
    try {
      const live = 'verification/receipts/LIVE01.json';
      const receipt = JSON.parse(readFileSync(join(f.root, live), 'utf8'));
      const item = receipt.bundle_deliveries[0];
      const manifest = JSON.parse(readFileSync(join(f.root, item.manifest_ref), 'utf8'));
      const file = manifest.files.find((entry: { normalizedRelativePath: string }) =>
        entry.normalizedRelativePath === 'nested/result.bin');
      const bytes = Buffer.from('{}');
      file.mediaType = mediaType;
      file.actualSizeBytes = bytes.length;
      file.sha256 = createHash('sha256').update(bytes).digest('hex');
      f.put(item.file_refs.find((ref: { normalized_relative_path: string }) =>
        ref.normalized_relative_path === 'nested/result.bin').evidence_ref, bytes);
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      f.put(item.manifest_ref, manifestBytes);
      item.manifest_hash = createHash('sha256').update(manifestBytes).digest('hex');
      f.put(live, receipt);
      const result = f.run();
      assert.notEqual(result.status, 0, mediaType);
      assert.match(result.stderr, /LIVE01\.bundle\.v1.*binary/i, mediaType);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('release verifier rejects incomplete declared manifest and missing baseline fields', () => {
  for (const defect of ['missing_declared_file', 'context_revision', 'snapshot_refs']) {
    const f = fixture();
    try {
      const live = 'verification/receipts/LIVE01.json';
      const receipt = JSON.parse(readFileSync(join(f.root, live), 'utf8'));
      const item = receipt.bundle_deliveries[0];
      const manifest = JSON.parse(readFileSync(join(f.root, item.manifest_ref), 'utf8'));
      if (defect === 'missing_declared_file') manifest.expectedPaths.push('missing.bin');
      else if (defect === 'context_revision') delete manifest.contextRevision;
      else delete manifest.snapshotRefs;
      const bytes = Buffer.from(JSON.stringify(manifest));
      f.put(item.manifest_ref, bytes);
      item.manifest_hash = createHash('sha256').update(bytes).digest('hex');
      f.put(live, receipt);
      const result = f.run();
      assert.notEqual(result.status, 0, defect);
      assert.match(result.stderr, /LIVE01\.bundle\.v1.*manifest|LIVE01\.bundle\.v1.*expected/i, defect);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('release verifier accepts a receiver-observed LIVE02 set without a producer declaration', () => {
  const f = fixture();
  try {
    const live = 'verification/receipts/LIVE02.json';
    const receipt = JSON.parse(readFileSync(join(f.root, live), 'utf8'));
    const item = receipt.bundle_deliveries[0];
    const manifest = JSON.parse(readFileSync(join(f.root, item.manifest_ref), 'utf8'));
    delete manifest.expectedPaths;
    manifest.expectedSetBasis = 'receiver_observed';
    const bytes = Buffer.from(JSON.stringify(manifest));
    f.put(item.manifest_ref, bytes);
    item.manifest_hash = createHash('sha256').update(bytes).digest('hex');
    f.put(live, receipt);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('release verifier rejects file-directory aliases and Windows-unsafe bundle paths', () => {
  for (const path of ['report.md/report.html', 'CON/report.html', 'report.html ']) {
    const f = fixture();
    try {
      const live = 'verification/receipts/LIVE01.json';
      const receipt = JSON.parse(readFileSync(join(f.root, live), 'utf8'));
      const item = receipt.bundle_deliveries[0];
      const manifest = JSON.parse(readFileSync(join(f.root, item.manifest_ref), 'utf8'));
      manifest.files[1].normalizedRelativePath = path;
      manifest.expectedPaths[1] = path;
      item.file_refs[1].normalized_relative_path = path;
      const bytes = Buffer.from(JSON.stringify(manifest));
      f.put(item.manifest_ref, bytes);
      item.manifest_hash = createHash('sha256').update(bytes).digest('hex');
      f.put(live, receipt);
      const result = f.run();
      assert.notEqual(result.status, 0, path);
      assert.match(result.stderr, /LIVE01\.bundle\.v1.*path|LIVE01\.bundle\.v1.*manifest/i, path);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('release verifier rejects contradictory duplicate capability IDs', () => {
  const f = fixture();
  try {
    const path = 'work/capability-matrix.json';
    const report = JSON.parse(readFileSync(join(f.root, path), 'utf8'));
    report.capabilities.unshift({ id: 'investigation.readonly_isolation', status: 'unsupported',
      evidence_refs: [] });
    f.put(path, report);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate capability/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('release verifier binds archived evidence HEAD to full ancestor source commit', () => {
  const f = fixture();
  try {
    assert.notEqual(f.git(['rev-parse', 'HEAD']), f.commit);
    assert.equal(f.run().status, 0, f.run().stderr);
    f.put('verification/logs/second-archive.log', 'second archive\n');
    f.git(['add', '--', 'verification/logs/second-archive.log']);
    f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-m', 'Archive later evidence']);
    assert.equal(f.run().status, 0, f.run().stderr);
    for (const invalid of [f.commit.slice(0, 12), '0'.repeat(f.commit.length),
      f.git(['rev-parse', 'HEAD^{tree}']), f.git(['hash-object', 'package.json'])]) {
      f.acceptance.source_commit = invalid;
      f.save();
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /source_commit|source commit/i);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('release verifier rejects a complete source commit from a non-ancestor branch', () => {
  const f = fixture();
  try {
    const originalBranch = f.git(['branch', '--show-current']);
    f.git(['checkout', '-b', 'side', f.commit]);
    f.put('side.txt', 'side branch');
    f.git(['add', '--', 'side.txt']);
    f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-m', 'Side branch source']);
    const side = f.git(['rev-parse', 'HEAD']);
    f.git(['checkout', originalBranch]);
    f.acceptance.source_commit = side;
    f.save();
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a verified ancestor/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('release verifier keeps receipts and capability report bound to source commit', () => {
  const f = fixture();
  try {
    const head = f.git(['rev-parse', 'HEAD']);
    const receiptPath = 'verification/receipts/AC01-live.json';
    const receipt = JSON.parse(readFileSync(join(f.root, receiptPath), 'utf8'));
    f.put(receiptPath, { ...receipt, source_commit: head });
    let result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AC01\.live.*source_commit/i);
    f.put(receiptPath, receipt);
    const reportPath = 'work/capability-matrix.json';
    const report = JSON.parse(readFileSync(join(f.root, reportPath), 'utf8'));
    f.put(reportPath, { ...report, source_commit: head });
    result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /capability_report.*source_commit/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('release verifier rejects protected committed changes after the source commit', () => {
  for (const path of ['src/feature.ts', 'tests/new.test.ts', 'tools/new.mjs', 'package.json',
    'package-lock.json', 'verification/evidence-record.schema.json',
    'verification/fixtures/project-a/README.md', 'verification/receipts-near/record.json',
    'work/MODEL_RESOLUTION.json', 'work/GOAL_STATE.json']) {
    const f = fixture();
    try {
      f.put(path, `changed ${path}\n`);
      f.git(['add', '--', path]);
      f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '-m', 'Change protected input']);
      const result = f.run();
      assert.notEqual(result.status, 0, `${path}: ${result.stdout}`);
      assert.match(result.stderr, /release inputs|protected|source commit/i, path);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('release verifier rejects staged, unstaged, and untracked protected files', () => {
  for (const state of ['staged', 'unstaged', 'untracked'] as const) {
    const f = fixture();
    try {
      const path = state === 'unstaged' ? 'package.json' : `src/${state}.ts`;
      f.put(path, `changed ${state}\n`);
      if (state === 'staged') f.git(['add', '--', path]);
      const result = f.run();
      assert.notEqual(result.status, 0, state);
      assert.match(result.stderr, /release inputs|protected/i, state);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('release verifier rejects moves between protected inputs and evidence output paths', () => {
  for (const [source, destination] of [
    ['package.json', 'verification/receipts/package-input.json'],
    ['verification/receipts/AC01-live.json', 'src/AC01-live.json'],
  ] as const) {
    const f = fixture();
    try {
      if (destination.startsWith('src/')) mkdirSync(join(f.root, 'src'), { recursive: true });
      f.git(['mv', '--', source, destination]);
      f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '-m', 'Move between input and evidence']);
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /release inputs differ from source commit/i);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('release verifier refuses protected input with hidden index change flags', () => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const f = fixture();
    try {
      f.git(['update-index', flag, '--', 'package.json']);
      f.put('package.json', { name: `changed-${flag}`, version: '2.0.0' });
      const result = f.run();
      assert.notEqual(result.status, 0, flag);
      assert.match(result.stderr, /release inputs|index flag|protected/i, flag);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});
