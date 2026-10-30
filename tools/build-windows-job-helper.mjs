import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist/src/adapters/codex/investigator');
const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const source = join(root, 'native/windows/WindowsJobHost.cs');
const temporary = join(output, `windows-job-${randomUUID()}.exe`);
try {
  if (process.platform !== 'win32' || process.argv.length !== 2) throw new Error('unsupported');
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error('source');
  mkdirSync(output, { recursive: true });
  const env = { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' };
  const version = spawnSync(compiler, ['/help'], { env, windowsHide: true,
    encoding: 'utf8', timeout: 10_000, maxBuffer: 32_768 });
  const compilerVersion = /^Microsoft \(R\) Visual C# Compiler version (4\.8\.[0-9.]+)\r?$/m.exec(version.stdout)?.[1];
  if (version.status !== 0 || version.error || !compilerVersion) throw new Error('compiler');
  const built = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+',
    `/out:${temporary}`, source], { env, windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 8192 });
  if (built.status !== 0 || built.error) throw new Error('compile');
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest = { schemaVersion: 1, helperVersion: '3', architecture: 'x64',
    compiler: { path: compiler, version: compilerVersion }, sourceSha256: hash(source), outputSha256: hash(temporary) };
  copyFileSync(source, join(output, 'windows-job-helper.cs'));
  renameSync(temporary, join(output, 'windows-job-helper.exe'));
  writeFileSync(join(output, 'windows-job-helper.manifest.json'), JSON.stringify(manifest) + '\n');
  process.stdout.write(JSON.stringify(manifest) + '\n');
} catch {
  process.stderr.write('WINDOWS_JOB_HELPER_BUILD_FAILED\n'); process.exitCode = 1;
} finally { rmSync(temporary, { force: true }); }
