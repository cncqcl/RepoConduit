import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// Release receipts are produced by execution outside this verifier. This tool only
// checks their completeness, binding, and references; it never changes acceptance.
const REQUIRED_LAYERS = {
  AC01: ['contracts', 'integration', 'mock_e2e', 'live'],
  AC02: ['integration', 'mock_e2e', 'live_human'],
  AC03: ['contracts', 'integration', 'mock_e2e', 'live'],
  AC04: ['contracts', 'integration', 'faults', 'live'],
  AC05: ['contracts', 'integration', 'faults', 'live'],
  AC06: ['contracts', 'integration', 'security'],
  AC07: ['contracts', 'integration', 'faults', 'live'],
  AC08: ['contracts', 'integration', 'security', 'faults'],
  AC09: ['contracts', 'integration', 'security', 'live_runtime'],
  AC10: ['contracts', 'integration', 'faults', 'live_runtime'],
  AC11: ['contracts', 'boundary', 'real_second_runtime'],
  AC12: ['contracts', 'integration', 'security', 'live'],
  AC13: ['contracts', 'integration', 'mock_e2e', 'live'],
  AC14: ['contracts', 'integration', 'faults', 'package_smoke'],
};
const EXECUTION_CASES = new Set([...Object.keys(REQUIRED_LAYERS),
  'LIVE01', 'LIVE02', 'LIVE03', 'NEUTRAL01']);
const REQUIRED_COMMANDS = ['typecheck', 'lint', 'test', 'test:contracts', 'test:integration',
  'test:faults', 'test:security', 'test:boundary', 'test:e2e:mock', 'build', 'package:smoke'];
const SINGLE_RUN_COMMANDS = new Set(['typecheck', 'lint', 'test', 'build', 'package:smoke']);
const SINGLE_RUN_SCRIPTS = {
  test: 'tsx --test --test-concurrency=2 tests/**/*.test.ts',
  'test:contracts': 'tsx --test tests/contracts/*.test.ts',
  'test:integration': 'tsx --test --test-concurrency=2 tests/integration/*.test.ts',
  'test:faults': 'tsx --test tests/faults/*.test.ts',
  'test:security': 'tsx --test tests/security/*.test.ts',
  'test:boundary': 'tsx --test tests/boundary/*.test.ts',
  'test:e2e:mock': 'tsx --test tests/e2e/*.mock.test.ts',
};
const REQUIRED_CAPABILITIES = ['mcp.chatgpt_remote', 'conversation.send',
  'conversation.read_history_delta', 'conversation.user_handoff', 'repository.pull',
  'investigation.submit', 'investigation.observe', 'investigation.readonly_isolation'];
const ROUTE_CAPABILITIES = {
  native_file_reference: 'artifact.accept_native_reference',
  authorized_local_collector: 'artifact.collect_from_external_ui',
};
const AUTOMATIC_FILE_RECEIPTS = new Set(['text_set_mcp', 'platform_file_reference', 'authorized_local_collector']);
const BINARY_ROUTE_RECEIPTS = {
  native_file_reference: 'platform_file_reference',
  authorized_local_collector: 'authorized_local_collector',
};
const EVIDENCE_FILES = new Set(['verification/RUNTIME_ACCEPTANCE.json', 'work/capability-matrix.json']);
const EVIDENCE_DIRS = ['verification/receipts/', 'verification/logs/', 'verification/live/'];
const evidenceOutput = (path) => EVIDENCE_FILES.has(path) || EVIDENCE_DIRS.some((dir) => path.startsWith(dir));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

function gitOutput(root, args) {
  const result = spawnSync('git', args, { cwd: root });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) return null;
  return result.stdout;
}

function nulPaths(output) {
  if (!output || (output.length && output.at(-1) !== 0)) return null;
  if (!output.length) return [];
  const decoded = output.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(output)) return null;
  const paths = decoded.slice(0, -1).split('\0');
  return paths.every((path) => path.length > 0) ? paths : null;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 2 || (args.length && (args[0] !== '--root' || !args[1]))) {
    console.error('Usage: node tools/verify-release.mjs [--root REPOSITORY_ROOT]');
    process.exitCode = 2;
    return;
  }
  const root = realpathSync(resolve(args[1] ?? '.'));
  const errors = [];
  const fail = (where, reason) => errors.push(`${where}: ${reason}`);
  const read = (path, where, json = true, maxBytes = null) => {
    if (!nonempty(path) || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes('\\') ||
        path.split('/').some((part) => !part || part === '.' || part === '..')) {
      fail(where, 'invalid repository-relative evidence path');
      return null;
    }
    const absolute = resolve(root, path);
    if (relative(root, absolute).startsWith('..' + sep) || relative(root, absolute) === '..') {
      fail(where, 'evidence path escapes repository');
      return null;
    }
    try {
      let cursor = root;
      for (const part of path.split('/')) {
        cursor = join(cursor, part);
        if (lstatSync(cursor).isSymbolicLink()) throw new Error('symbolic link in evidence path');
      }
      const stat = statSync(absolute);
      if (!stat.isFile() || (json !== 'bytes' && stat.size === 0))
        throw new Error('missing or empty file');
      if (maxBytes !== null && (stat.size < 1 || stat.size > maxBytes))
        throw new Error('archive must be nonempty and at most 32 MiB');
      const content = readFileSync(absolute);
      return json === 'bytes' ? content : json ? JSON.parse(content.toString('utf8')) : content.toString('utf8');
    } catch (error) {
      fail(where, `cannot read evidence ${path}: ${error.message}`);
      return null;
    }
  };
  const acceptance = read('verification/RUNTIME_ACCEPTANCE.json', 'acceptance');
  if (!isObject(acceptance)) {
    fail('acceptance', 'root must be a JSON object');
    return finish(errors);
  }
  const evidenceSchema = read('verification/evidence-record.schema.json', 'evidence schema');
  const receiptProperties = evidenceSchema?.properties;
  const receiptCases = receiptProperties?.case_id?.enum;
  const receiptLayers = receiptProperties?.layer?.enum;
  const receiptPurposes = evidenceSchema?.oneOf;
  if (!isObject(receiptProperties) || evidenceSchema?.additionalProperties !== false ||
      receiptProperties.schema_version?.const !== '0.2' ||
      !Array.isArray(receiptCases) || !Array.isArray(receiptLayers) ||
      !Array.isArray(receiptPurposes))
    fail('evidence schema', 'invalid closed receipt vocabulary');
  const knownReceiptFields = new Set(Object.keys(isObject(receiptProperties) ? receiptProperties : {}));
  const headOutput = gitOutput(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const head = headOutput?.toString('utf8').trim();
  if (!head || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head))
    fail('repository', 'current commit unavailable');
  const commit = acceptance.source_commit;
  const validOid = typeof commit === 'string' && head && commit.length === head.length &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit);
  if (!validOid || gitOutput(root, ['cat-file', '-t', commit])?.toString('utf8').trim() !== 'commit' ||
      gitOutput(root, ['rev-parse', '--verify', commit])?.toString('utf8').trim() !== commit) {
    fail('acceptance.source_commit', 'must be a full existing commit OID');
  } else {
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', commit, head], { cwd: root });
    if (ancestor.error || ancestor.status !== 0)
      fail('acceptance.source_commit', 'source commit is not a verified ancestor of HEAD');
    else {
      const committed = nulPaths(gitOutput(root, ['diff', '--name-only', '-z', '--no-renames', commit, head, '--']));
      if (!committed) fail('repository', 'cannot inspect committed release inputs');
      else for (const path of committed) if (!evidenceOutput(path))
        fail('repository', `release inputs differ from source commit: ${path}`);
    }
  }
  for (const [label, args] of [
    ['staged', ['diff', '--cached', '--name-only', '-z', '--no-renames', '--']],
    ['unstaged', ['diff', '--name-only', '-z', '--no-renames', '--']],
    ['untracked', ['ls-files', '--others', '--exclude-standard', '-z', '--']],
  ]) {
    const paths = nulPaths(gitOutput(root, args));
    if (!paths) fail('repository', `cannot inspect ${label} release inputs`);
    else for (const path of paths) if (!evidenceOutput(path))
      fail('repository', `release inputs differ from source commit (${label}): ${path}`);
  }
  // Git's normal diff omits paths marked assume-unchanged or skip-worktree.
  // Refuse those flags on every protected tracked input before trusting the tree comparison.
  const tracked = nulPaths(gitOutput(root, ['ls-files', '-v', '-z', '--']));
  if (!tracked) fail('repository', 'cannot inspect tracked input flags');
  else for (const entry of tracked) {
    if (!/^.{1} .+$/s.test(entry)) { fail('repository', 'invalid tracked input flag record'); continue; }
    const tag = entry[0];
    const path = entry.slice(2);
    if (!evidenceOutput(path) && tag !== 'H')
      fail('repository', `protected release input has hidden index flag: ${path}`);
  }
  if (acceptance.schema_version !== '0.2') fail('acceptance', 'unsupported schema_version');
  if (acceptance.status !== 'passed') fail('acceptance.status', `expected passed, got ${acceptance.status ?? 'missing'}`);
  if (!validOid) fail('acceptance.source_commit', 'does not match repository object format');
  if (!nonempty(acceptance.build_id)) fail('acceptance.build_id', 'missing build binding');
  if (!nonempty(acceptance.platform)) fail('acceptance.platform', 'missing platform');
  if (!nonempty(acceptance.account_ref)) fail('acceptance.account_ref', 'missing non-sensitive account reference');
  if (acceptance.capabilities_verified !== true) fail('acceptance.capabilities_verified', 'must be true');
  if (!Array.isArray(acceptance.blockers) || acceptance.blockers.length) fail('acceptance.blockers', 'must be an empty array');
  if (acceptance.generated_by === 'handoff_author') fail('acceptance.generated_by', 'handoff record cannot certify product release');

  const packageDeclaration = acceptance.release_artifact;
  const packageKeys = ['archive_ref', 'sha256', 'integrity'];
  const identityValid = (value, keys) => isObject(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)) &&
    nonempty(value.archive_ref) && typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.sha256) && typeof value.integrity === 'string' &&
    /^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity);
  if (!identityValid(packageDeclaration, packageKeys))
    fail('acceptance.release_artifact', 'missing or malformed archive identity');
  const archive = identityValid(packageDeclaration, packageKeys)
    ? read(packageDeclaration.archive_ref, 'acceptance.release_artifact.archive_ref', 'bytes', 32 * 1024 * 1024)
    : null;
  if (archive) {
    const sha256 = createHash('sha256').update(archive).digest('hex');
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
    if (packageDeclaration.sha256 !== sha256 || packageDeclaration.integrity !== integrity)
      fail('acceptance.release_artifact', 'archive bytes do not match SHA-256 and SRI');
  }
  const smokeOutputKeys = new Set(['status', 'package', 'installedCli',
    'installedProfileConfiguration', 'installedProfileReplayAcrossProcesses',
    'installedMcpRoundTrip', 'installedMcpArtifactDiscovery', 'workspaceRegistered',
    'oauthConfigured', 'oauthHttpStarted', 'installedDocs',
    'installedFileOriginsConfigured', 'mutableEvidenceExcluded', 'packageIntegrity',
    'installedHostSkillFiles', 'installedNoticeFiles', 'packageSha256', 'packageArchiveRetained']);
  const hostSkillPaths = new Set([
    'skills/consult-external-agent/SKILL.md',
    'skills/consult-external-agent/agents/openai.yaml',
    'skills/consult-external-agent/references/commands.md',
  ]);
  const hostSkillFilesValid = (files) => Array.isArray(files) && files.length === hostSkillPaths.size &&
    new Set(files.map((file) => file?.path)).size === hostSkillPaths.size &&
    files.every((file) => isObject(file) && Object.keys(file).length === 3 &&
      Object.hasOwn(file, 'path') && hostSkillPaths.has(file.path) &&
      Object.hasOwn(file, 'bytes') && Number.isSafeInteger(file.bytes) && file.bytes > 0 &&
      Object.hasOwn(file, 'sha256') && typeof file.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(file.sha256));
  const checkPackageReceipt = (receipt, label) => {
    const record = receipt.package_artifact;
    if (!identityValid(record, packageKeys) || !nonempty(receipt.package_smoke_output_ref)) {
      fail(label, 'package_artifact missing or malformed identity/output reference');
      return;
    }
    if (!identityValid(packageDeclaration, packageKeys) ||
        packageKeys.some((key) => record[key] !== packageDeclaration[key]))
      fail(label, 'package_artifact does not match acceptance.release_artifact');
    if (!Array.isArray(receipt.evidence_refs) ||
        !receipt.evidence_refs.includes(receipt.package_smoke_output_ref))
      fail(label, 'package smoke output reference must be listed in evidence_refs');
    const output = read(receipt.package_smoke_output_ref, `${label}.package_smoke_output_ref`, false);
    if (output === null) return;
    const lines = output.split(/\r?\n/).filter((line) => line.trim().length);
    const candidates = [];
    let malformedCandidate = false;
    for (const [index, line] of lines.entries()) {
      if (!line.trim().startsWith('{')) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch {
        if (/"(?:packageSha256|packageIntegrity|status)"/.test(line)) malformedCandidate = true;
        continue;
      }
      if (isObject(parsed) && (Object.hasOwn(parsed, 'packageSha256') ||
          Object.hasOwn(parsed, 'packageIntegrity') || Object.hasOwn(parsed, 'status')))
        candidates.push({ index, parsed });
    }
    if (malformedCandidate || candidates.length !== 1 || candidates[0].index !== lines.length - 1 ||
        Object.keys(candidates[0].parsed).some((key) => !smokeOutputKeys.has(key)) ||
        candidates[0].parsed.status !== 'passed' ||
        candidates[0].parsed.packageSha256 !== packageDeclaration?.sha256 ||
        candidates[0].parsed.packageIntegrity !== packageDeclaration?.integrity ||
        (Object.hasOwn(candidates[0].parsed, 'installedHostSkillFiles') &&
          !hostSkillFilesValid(candidates[0].parsed.installedHostSkillFiles)))
      fail(label, 'package smoke output must have one final passed JSON result matching archive identity');
  };

  const checkRefs = (entry, where, expected = {}, executionOnly = false) => {
    if (!Array.isArray(entry?.evidence_refs) || !entry.evidence_refs.length) {
      fail(where, 'missing evidence_refs');
      return;
    }
    for (const [index, path] of entry.evidence_refs.entries()) {
      const label = `${where}.evidence_refs[${index}]`;
      const receipt = read(path, label);
      if (!isObject(receipt)) { fail(label, 'receipt must be a JSON object'); continue; }
      if (receipt.schema_version !== '0.2') fail(label, 'receipt schema_version must be 0.2');
      if (!nonempty(receipt.run_id)) fail(label, 'receipt missing run_id');
      if (!Array.isArray(receiptCases) || !receiptCases.includes(receipt.case_id))
        fail(label, 'receipt unknown or missing case_id');
      if (!Array.isArray(receiptLayers) || !receiptLayers.includes(receipt.layer))
        fail(label, 'receipt unknown or missing layer');
      else if (Array.isArray(receiptPurposes) && Array.isArray(receiptCases) &&
          receiptCases.includes(receipt.case_id) &&
          !receiptPurposes.some((purpose) =>
            purpose?.properties?.case_id?.enum?.includes(receipt.case_id) &&
            (purpose?.properties?.layer?.const === receipt.layer ||
              purpose?.properties?.layer?.enum?.includes(receipt.layer))))
        fail(label, 'receipt layer is not allowed for case_id');
      if (executionOnly && !EXECUTION_CASES.has(receipt.case_id))
        fail(label, 'capability evidence must be an AC/LIVE/NEUTRAL execution receipt');
      for (const key of Object.keys(receipt)) if (!knownReceiptFields.has(key))
        fail(label, `receipt unknown top-level field ${key}`);
      if (receipt.status !== 'passed') fail(label, `receipt status ${receipt.status ?? 'missing'} is not passed`);
      if (receipt.source_commit !== commit) fail(where, 'receipt source_commit does not match source commit');
      if (receipt.build_id !== acceptance.build_id) fail(where, 'receipt build_id does not match current build');
      for (const field of ['started_at', 'finished_at', 'executor', 'command', 'cwd']) {
        if (!nonempty(receipt[field])) fail(label, `receipt missing ${field}`);
      }
      if (Number.isNaN(Date.parse(receipt.started_at)) || Number.isNaN(Date.parse(receipt.finished_at)) ||
          Date.parse(receipt.started_at) > Date.parse(receipt.finished_at)) fail(label, 'invalid receipt timestamps');
      if (receipt.exit_code !== 0) fail(label, 'receipt exit_code must be 0');
      if (!Array.isArray(receipt.blockers) || receipt.blockers.length) fail(label, 'receipt blockers must be empty');
      if (!Array.isArray(receipt.observations) || !receipt.observations.length) fail(label, 'missing observed assertions');
      else for (const [i, observation] of receipt.observations.entries()) {
        if (!nonempty(observation?.assertion) || !nonempty(observation?.observed))
          fail(`${label}.observations[${i}]`, 'missing assertion or observation');
        if (!Array.isArray(observation?.evidence_refs) || !observation.evidence_refs.length)
          fail(`${label}.observations[${i}]`, 'missing observation evidence_refs');
        else for (const [j, artifact] of observation.evidence_refs.entries())
          read(artifact, `${label}.observations[${i}].artifact[${j}]`, false);
      }
      if (!Array.isArray(receipt.evidence_refs) || !receipt.evidence_refs.length) fail(label, 'missing underlying log/file references');
      else for (const [i, artifact] of receipt.evidence_refs.entries()) read(artifact, `${label}.artifact[${i}]`, false);
      if (['live', 'live_human', 'live_runtime', 'real_second_runtime'].includes(expected.layer) &&
          (!isObject(receipt.runtime_versions) || !Object.keys(receipt.runtime_versions).length))
        fail(label, 'live receipt missing actual runtime_versions');
      for (const [key, value] of Object.entries(expected)) {
        if (receipt[key] !== value) fail(label, `receipt ${key} does not match ${value}`);
      }
      if ((receipt.case_id === 'PACKAGE01' && receipt.layer === 'package_smoke') ||
          (receipt.case_id === 'AC14' && receipt.layer === 'package_smoke') ||
          (receipt.case_id === 'offline:package:smoke' && receipt.layer === 'offline_command'))
        checkPackageReceipt(receipt, label);
    }
  };
  const gate = (entry, where, expected = {}) => {
    if (entry?.status !== 'passed') {
      fail(where, `expected passed, got ${entry?.status ?? 'missing'}`);
      return;
    }
    checkRefs(entry, where, expected);
  };
  for (const name of ['core_verified', 'flagship_live_verified', 'release_ready'])
    gate(acceptance.stages?.[name], `stages.${name}`, { case_id: `stage:${name}`, layer: 'review' });
  const cases = new Map();
  if (!Array.isArray(acceptance.acceptance_cases)) fail('acceptance_cases', 'missing array');
  else for (const ac of acceptance.acceptance_cases) {
    if (cases.has(ac?.id)) fail(`acceptance_cases.${ac.id}`, 'duplicate ID');
    cases.set(ac?.id, ac);
  }
  for (const [id, layers] of Object.entries(REQUIRED_LAYERS)) {
    const ac = cases.get(id);
    for (const layer of layers) gate(ac?.layers?.[layer], `${id}.${layer}`, { case_id: id, layer });
  }
  const runs = new Map();
  if (!Array.isArray(acceptance.live_runs)) fail('live_runs', 'missing array');
  else for (const run of acceptance.live_runs) {
    if (runs.has(run?.id)) fail(`live_runs.${run.id}`, 'duplicate ID');
    runs.set(run?.id, run);
  }
  for (const id of ['LIVE01', 'LIVE02', 'LIVE03', 'NEUTRAL01']) {
    const run = runs.get(id);
    if (!nonempty(run?.run_id)) fail(id, 'missing run_id');
    gate(run, id, { case_id: id, run_id: run?.run_id,
      layer: id === 'NEUTRAL01' ? 'real_second_runtime' : 'live' });
  }
  if (acceptance.human_handoff?.actual_human_performed !== true)
    fail('human_handoff', 'actual_human_performed must be true after real human action');
  gate(acceptance.human_handoff, 'human_handoff', { case_id: 'AC02', layer: 'live_human', actual_human_performed: true });
  gate(acceptance.clean_package_smoke, 'clean_package_smoke', { case_id: 'PACKAGE01', layer: 'package_smoke' });
  if (acceptance.model_loading?.status !== 'passed') fail('model_loading', 'must be passed');
  else {
    const modelRef = acceptance.model_loading.evidence_record;
    if (!nonempty(modelRef)) fail('model_loading', 'missing evidence_record');
    else checkRefs({ evidence_refs: [modelRef] }, 'model_loading',
      { case_id: 'release:model_loading', layer: 'review' });
  }

  const release = acceptance.release_evidence;
  const offlineTestMode = release?.offline_test_mode;
  if (offlineTestMode !== undefined && offlineTestMode !== 'single_run')
    fail('release_evidence.offline_test_mode', 'must be single_run when present');
  const singleRun = offlineTestMode === 'single_run';
  if (singleRun) {
    const packageJson = read('package.json', 'package.json');
    for (const [name, expected] of Object.entries(SINGLE_RUN_SCRIPTS))
      if (packageJson?.scripts?.[name] !== expected)
        fail(`package.json.scripts.${name}`, 'must match the unfiltered release test script');
    if (isObject(release?.offline_commands))
      for (const name of Object.keys(release.offline_commands))
        if (!REQUIRED_COMMANDS.includes(name)) fail(`offline_commands.${name}`, 'unknown command');
  }
  for (const command of REQUIRED_COMMANDS) {
    const entry = release?.offline_commands?.[command];
    if (singleRun && !SINGLE_RUN_COMMANDS.has(command) && entry === undefined) continue;
    gate(entry, `offline_commands.${command}`,
      { case_id: `offline:${command}`, layer: 'offline_command', command: `npm run ${command}` });
  }
  for (const name of ['license_review', 'secret_scan', 'safety_defects', 'capability_report'])
    gate(release?.[name], name, { case_id: `release:${name}`, layer: 'review' });
  if (!Array.isArray(release?.safety_defects?.unresolved_critical) || release.safety_defects.unresolved_critical.length)
    fail('safety_defects.unresolved_critical', 'must be an empty reviewed list');

  const route = acceptance.effective_collection_route;
  if (!Object.hasOwn(ROUTE_CAPABILITIES, route))
    fail('effective_collection_route', 'must be a verified automatic multi-file/binary route');
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
  const safeFilePath = (path) => nonempty(path) && path === path.normalize('NFC') &&
    !path.includes('\\') && !path.includes('\0') && !path.startsWith('/') &&
    !/^[A-Za-z]:/.test(path) && [...path].every((character) => {
      const code = character.charCodeAt(0);
      return character.length !== 1 || code < 0xd800 || code > 0xdfff;
    }) && path.split('/').every((part) => part && part !== '.' && part !== '..' &&
      !/[. ]$/.test(part) && !reserved.test(part) && !/[<>:"|?*]/.test(part) &&
      [...part].every((character) => character.charCodeAt(0) >= 32));
  const validPathSet = (paths) => {
    if (!Array.isArray(paths) || !paths.every(safeFilePath)) return false;
    const files = new Set();
    const directories = new Map();
    for (const path of paths) {
      const key = path.toLocaleLowerCase('en-US');
      if (files.has(key)) return false;
      files.add(key);
    }
    for (const path of paths) for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
      const directory = path.slice(0, at);
      const key = directory.toLocaleLowerCase('en-US');
      if (files.has(key) || (directories.has(key) && directories.get(key) !== directory)) return false;
      directories.set(key, directory);
    }
    return true;
  };
  const deliveryByRun = new Map();
  const v1BinaryRoutes = new Set();
  for (const [runId, roles] of [['LIVE01', ['v1', 'v2']], ['LIVE02', ['independent']]]) {
    const run = runs.get(runId);
    const refs = Array.isArray(run?.evidence_refs) ? run.evidence_refs : [];
    if (refs.length !== 1) { fail(runId, 'bundle delivery requires one exact live run receipt'); continue; }
    const receipt = read(refs[0], `${runId}.bundle_receipt`);
    if (!isObject(receipt) || receipt.status !== 'passed' || receipt.case_id !== runId ||
      receipt.layer !== 'live' || receipt.source_commit !== commit ||
      receipt.build_id !== acceptance.build_id) continue;
    const deliveries = receipt.bundle_deliveries;
    if (!Array.isArray(deliveries) || deliveries.length !== roles.length ||
      new Set(deliveries.map((item) => item?.role)).size !== roles.length ||
      !roles.every((role) => deliveries.some((item) => item?.role === role))) {
      fail(runId, 'missing exact bundle delivery roles');
      continue;
    }
    const checked = new Map();
    for (const item of deliveries) {
      const where = `${runId}.bundle.${item.role}`;
      if (!isObject(item) || !nonempty(item.manifest_ref) ||
        !item.manifest_ref.startsWith('verification/live/') ||
        !/^[0-9a-f]{64}$/.test(item.manifest_hash)) { fail(where, 'invalid manifest evidence'); continue; }
      const manifestBytes = read(item.manifest_ref, `${where}.manifest`, 'bytes');
      if (!Buffer.isBuffer(manifestBytes)) continue;
      if (sha256(manifestBytes) !== item.manifest_hash) { fail(where, 'bundle manifest hash mismatch'); continue; }
      let manifest;
      try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
      catch { fail(where, 'invalid bundle manifest JSON'); continue; }
      if (!isObject(manifest) || !nonempty(manifest.bundleId) ||
        !nonempty(manifest.workspaceId) || !nonempty(manifest.collaborationId) ||
        !nonempty(manifest.contextRevision) || !Array.isArray(manifest.snapshotRefs) ||
        !manifest.snapshotRefs.length || !manifest.snapshotRefs.every(nonempty) ||
        manifest.semanticStatus !== 'not_reviewed' ||
        !['producer_declared', 'receiver_observed'].includes(manifest.expectedSetBasis) ||
        !Array.isArray(manifest.files) || manifest.files.length < 2 ||
        !Array.isArray(item.file_refs) || item.file_refs.length !== manifest.files.length) {
        fail(where, 'incomplete published bundle manifest or file evidence');
        continue;
      }
      const manifestPaths = manifest.files.map((file) => file?.normalizedRelativePath);
      const expectedPaths = manifest.expectedPaths;
      if (!validPathSet(manifestPaths) ||
        (manifest.expectedSetBasis === 'producer_declared' &&
          (!validPathSet(expectedPaths) || expectedPaths.length !== manifestPaths.length ||
            !expectedPaths.every((path) => manifestPaths.includes(path)))) ||
        (manifest.expectedSetBasis === 'receiver_observed' && expectedPaths !== undefined)) {
        fail(where, 'invalid manifest file paths or expected set');
        continue;
      }
      if (!validPathSet(item.file_refs.map((ref) => ref?.normalized_relative_path))) {
        fail(where, 'invalid file evidence paths');
        continue;
      }
      const fileRefs = new Map();
      for (const ref of item.file_refs) {
        if (!isObject(ref) || !safeFilePath(ref.normalized_relative_path) ||
          !nonempty(ref.evidence_ref) || !ref.evidence_ref.startsWith('verification/live/') ||
          fileRefs.has(ref.normalized_relative_path)) { fail(where, 'invalid or duplicate file evidence reference'); continue; }
        fileRefs.set(ref.normalized_relative_path, ref.evidence_ref);
      }
      const paths = new Set();
      for (const file of manifest.files) {
        if (!isObject(file) || !safeFilePath(file.normalizedRelativePath) ||
          paths.has(file.normalizedRelativePath.normalize('NFC').toLowerCase()) ||
          !Number.isSafeInteger(file.actualSizeBytes) || file.actualSizeBytes < 0 ||
          !/^[0-9a-f]{64}$/.test(file.sha256) || !nonempty(file.mediaType) ||
          !AUTOMATIC_FILE_RECEIPTS.has(file.sourceReceipt)) {
          fail(where, 'invalid or non-automatic bundle file route');
          continue;
        }
        paths.add(file.normalizedRelativePath.normalize('NFC').toLowerCase());
        const ref = fileRefs.get(file.normalizedRelativePath);
        if (!ref) { fail(where, `missing file evidence for ${file.normalizedRelativePath}`); continue; }
        const bytes = read(ref, `${where}.file.${file.normalizedRelativePath}`, 'bytes');
        const validBytes = Buffer.isBuffer(bytes) && bytes.length === file.actualSizeBytes &&
          sha256(bytes) === file.sha256;
        if (!validBytes)
          fail(where, `bundle file hash or size mismatch: ${file.normalizedRelativePath}`);
        const mediaType = file.mediaType.toLowerCase().split(';', 1)[0]?.trim();
        const textMedia = mediaType.startsWith('text/') ||
          ['application/json', 'application/xml', 'application/javascript', 'image/svg+xml'].includes(mediaType) ||
          mediaType.endsWith('+json') || mediaType.endsWith('+xml');
        let printableText = false;
        if (validBytes) try {
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          printableText = !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(decoded);
        } catch { /* Invalid UTF-8 is binary evidence. */ }
        const binary = validBytes && !textMedia &&
          (!printableText || (mediaType === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-'));
        if (binary && file.actualSizeBytes > 0) for (const [name, source] of Object.entries(BINARY_ROUTE_RECEIPTS))
          if (file.sourceReceipt === source) {
            if (runId === 'LIVE01' && item.role === 'v1') v1BinaryRoutes.add(name);
          }
      }
      if (fileRefs.size !== manifest.files.length) fail(where, 'file evidence set differs from manifest');
      checked.set(item.role, manifest);
    }
    deliveryByRun.set(runId, checked);
  }
  const v1 = deliveryByRun.get('LIVE01')?.get('v1');
  const v2 = deliveryByRun.get('LIVE01')?.get('v2');
  const independent = deliveryByRun.get('LIVE02')?.get('independent');
  if (v1 && (!v1.files.some((file) => file.normalizedRelativePath.endsWith('.md')) ||
      !v1.files.some((file) => file.normalizedRelativePath.endsWith('.html')) ||
      !v1.files.some((file) => file.normalizedRelativePath.endsWith('.json')) ||
      !v1.files.some((file) => file.normalizedRelativePath.includes('/'))))
    fail('LIVE01.bundle.v1', 'missing Markdown, HTML, JSON or nested file');
  if (v1 && v2 && (v2.parentBundleId !== v1.bundleId || v2.bundleId === v1.bundleId ||
      v2.workspaceId !== v1.workspaceId || v2.collaborationId !== v1.collaborationId))
    fail('LIVE01.bundle.v2', 'invalid version parent or collaboration binding');
  if (v1 && independent && independent.workspaceId === v1.workspaceId)
    fail('LIVE02.bundle', 'independent run must use another workspace');
  if (v1 && !v1BinaryRoutes.size) fail('LIVE01.bundle.v1', 'missing automatic original binary or ZIP file');
  if (Object.hasOwn(ROUTE_CAPABILITIES, route) && !v1BinaryRoutes.has(route))
    fail('effective_collection_route', 'selected binary route is absent from verified LIVE01 v1 files');
  const report = release?.capability_report?.status === 'passed'
    ? read(release.capability_report.report_ref, 'capability_report.report_ref') : null;
  if (isObject(report)) {
    if (report.source_commit !== commit) fail('capability_report', 'source_commit does not match source commit');
    if (report.build_id !== acceptance.build_id) fail('capability_report', 'build_id does not match current build');
    if (report.account_ref !== acceptance.account_ref) fail('capability_report', 'account_ref does not match acceptance');
    if (!nonempty(report.observed_at) || Number.isNaN(Date.parse(report.observed_at)))
      fail('capability_report', 'missing observed_at');
    const capabilities = new Map();
    if (Array.isArray(report.capabilities)) for (const item of report.capabilities) {
      if (capabilities.has(item?.id)) fail('capability_report', `duplicate capability ID: ${item?.id}`);
      capabilities.set(item?.id, item);
    }
    for (const id of [...REQUIRED_CAPABILITIES, ROUTE_CAPABILITIES[route]].filter(Boolean)) {
      const item = capabilities.get(id);
      if (item?.status !== 'supported') fail(`capability_report.${id}`, `expected supported, got ${item?.status ?? 'missing'}`);
      checkRefs(item, `capability_report.${id}`, {}, true);
    }
  } else fail('capability_report', 'report must be a JSON object');
  finish(errors, { source: commit, head, build: acceptance.build_id });
}

function finish(errors, binding) {
  if (errors.length) {
    console.error(`release_ready BLOCKED (${errors.length} reason${errors.length === 1 ? '' : 's'}):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else console.log(`release_ready: verified evidence graph for source commit ${binding.source}, evidence HEAD ${binding.head}, build ${binding.build}`);
}

try { main(); }
catch (error) { console.error(`release_ready BLOCKED: ${error.message}`); process.exitCode = 1; }
