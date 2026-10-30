#!/usr/bin/env node
// Synthetic App Server capability probe. Never point this at a real repository.
import { spawn } from 'node:child_process';
import console from 'node:console';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

const timeoutMs = 90_000;
const marker = 'RCAC_SYNTHETIC_DYNAMIC_01561';
const featureOff = ['shell_tool', 'apps', 'plugins', 'browser_use', 'computer_use', 'in_app_browser', 'image_generation', 'multi_agent'];
const args = ['app-server', '--stdio', '--strict-config', ...featureOff.flatMap((x) => ['--disable', x]), '-c', 'web_search="disabled"', '-c', 'apps._default.enabled=false', '-c', 'mcp_servers={}'];
const windowsCliRoot = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'CodexCLI', '0.156.1');
const windowsCli = join(windowsCliRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');

function childEnv() {
  const names = ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CODEX_HOME'];
  return Object.fromEntries(names.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
}

function start(commandArgs, cwd) {
  if (process.platform === 'win32' && !existsSync(windowsCli)) {
    throw new Error('Pinned Codex CLI installation is unavailable');
  }
  return spawn(process.platform === 'win32' ?
    (existsSync(join(windowsCliRoot, 'node.exe')) ? join(windowsCliRoot, 'node.exe') : process.execPath) : 'codex',
    process.platform === 'win32' ? [windowsCli, ...commandArgs] : commandArgs,
    { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', reject);
      killer.once('exit', (code) => code === 0 ? resolve() : reject(new Error('taskkill failed')));
    });
  } else child.kill('SIGKILL');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null && child.signalCode === null) throw new Error('child termination unconfirmed');
}

async function runPreflight(commandArgs, cwd) {
  const child = start(commandArgs, cwd);
  let stdout = '';
  let stderrBytes = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 8192) child.kill(); });
  child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; if (stderrBytes > 8192) child.kill(); });
  let timer;
  try {
    const code = await Promise.race([
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('preflight timed out')), 20_000); }),
    ]);
    if (code !== 0) throw new Error('preflight failed');
    return stdout;
  } finally {
    clearTimeout(timer);
    await stop(child);
  }
}

function rpc(child, onEvent) {
  let nextId = 1;
  let buffer = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let item;
      try { item = JSON.parse(line); } catch { onEvent({ method: 'invalid-json' }); continue; }
      if (item.id !== undefined && pending.has(item.id)) {
        const { resolve, reject, timer } = pending.get(item.id);
        pending.delete(item.id);
        clearTimeout(timer);
        if (item.error) reject(new Error(`RPC ${item.error.code ?? 'error'}`));
        else resolve(item.result);
      } else onEvent(item);
    }
  });
  child.once('exit', () => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('app-server exited')); }
    pending.clear();
  });
  return {
    call(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${method} timed out`)); }, 20_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    reply(id, result) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); },
    notify(method) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`); },
  };
}

async function run() {
  const receipt = { probe: 'codex-dynamic-positive', cli: 'unverified', status: 'not_run', threadStarted: false, dynamicCallback: false, turnCompleted: false, mcpServerCount: 'unverified', nativeRequestMethods: [], eventMethods: [], isolation: 'unverified' };
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'rcac-dynamic-'));
  const cwd = join(temporaryRoot, 'empty-workspace');
  const schemaDir = join(cwd, 'schema');
  await mkdir(cwd);
  await mkdir(schemaDir);
  let child;
  let deadline;
  try {
    const versionOutput = await runPreflight(['--version'], cwd);
    if (versionOutput.trim() !== 'codex-cli 0.156.1') throw new Error('CLI version is not codex-cli 0.156.1');
    receipt.cli = versionOutput.trim();
    // The generated schema is the installed binary's contract, checked before any model turn.
    await runPreflight(['app-server', 'generate-json-schema', '--experimental', '--out', 'schema'], cwd);
    const threadSchema = JSON.parse(await readFile(join(schemaDir, 'v2', 'ThreadStartParams.json'), 'utf8'));
    const turnSchema = JSON.parse(await readFile(join(schemaDir, 'v2', 'TurnStartParams.json'), 'utf8'));
    const dynamicSchema = JSON.parse(await readFile(join(schemaDir, 'DynamicToolCallParams.json'), 'utf8'));
    if (!threadSchema.properties.dynamicTools || !threadSchema.properties.environments || !turnSchema.properties.environments || !dynamicSchema.properties.tool || !dynamicSchema.properties.callId) throw new Error('installed v2 schema lacks required fields');
    receipt.schemaChecked = true;

    child = start(args, cwd);
    let stderrBytes = 0;
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 8192) child.kill();
    });
    const finished = new Promise((resolve) => { deadline = setTimeout(() => resolve('timeout'), timeoutMs); });
    let complete;
    const completed = new Promise((resolve) => { complete = resolve; });
    child.once('error', () => complete('process-error'));
    const protocol = rpc(child, (event) => {
      if (typeof event.method !== 'string') return;
      if (!receipt.eventMethods.includes(event.method)) receipt.eventMethods.push(event.method);
      if (event.id !== undefined) {
        if (event.method === 'item/tool/call' && event.params?.tool === 'synthetic_marker' && event.params?.arguments?.marker === marker) {
          receipt.dynamicCallback = true;
          protocol.reply(event.id, { success: true, contentItems: [{ type: 'inputText', text: marker }] });
        } else {
          receipt.nativeRequestMethods.push(event.method);
          complete('unexpected-request');
        }
      }
      if (event.method === 'turn/completed') {
        receipt.turnCompleted = event.params?.turn?.status === 'completed';
        complete(receipt.turnCompleted ? 'completed' : 'turn-failed');
      }
    });
    child.once('exit', () => complete('process-exit'));
    await protocol.call('initialize', { clientInfo: { name: 'rcac-synthetic-probe', version: '0.1' }, capabilities: { experimentalApi: true } });
    protocol.notify('initialized');
    const config = await protocol.call('config/read', { cwd, includeLayers: false });
    if (config?.config?.web_search !== 'disabled' || config?.config?.apps?._default?.enabled !== false) throw new Error('effective config did not confirm web/apps disabled');
    receipt.configChecked = true;
    const started = await protocol.call('thread/start', {
      cwd, environments: [], ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
      dynamicTools: [{ type: 'function', name: 'synthetic_marker', description: 'Return the fixed synthetic probe marker. No filesystem or network access.', inputSchema: { type: 'object', properties: { marker: { type: 'string', enum: [marker] } }, required: ['marker'], additionalProperties: false } }],
    });
    const threadId = started?.thread?.id;
    if (typeof threadId !== 'string') throw new Error('thread/start did not return a thread id');
    receipt.threadStarted = true;
    const mcp = await protocol.call('mcpServerStatus/list', { threadId, limit: 100 });
    if (!Array.isArray(mcp?.data) || mcp.nextCursor) throw new Error('MCP inventory was incomplete');
    receipt.mcpServerCount = mcp.data.length;
    if (mcp.data.length !== 0) throw new Error('MCP inventory is not empty');
    await protocol.call('turn/start', { threadId, environments: [], approvalPolicy: 'never', input: [{ type: 'text', text: `This is a synthetic capability probe. Invoke synthetic_marker once with marker ${marker}, then report only whether it returned. Do not use any other tool.` }] });
    const outcome = await Promise.race([completed, finished]);
    receipt.status = outcome === 'completed' && receipt.dynamicCallback && receipt.nativeRequestMethods.length === 0 ? 'positive_callback_observed' : outcome;
  } catch (error) { receipt.status = 'failed_closed'; receipt.error = String(error.message).slice(0, 160); }
  finally {
    clearTimeout(deadline);
    try { await stop(child); }
    catch { receipt.status = 'failed_closed'; receipt.cleanup = 'termination_unconfirmed'; }
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      await rm(temporaryRoot, { recursive: true, force: true });
    } else receipt.cleanup = 'temporary_files_preserved_until_child_stops';
  }
  console.log(JSON.stringify(receipt, null, 2));
  process.exitCode = receipt.status === 'positive_callback_observed' ? 0 : 1;
}

await run();
