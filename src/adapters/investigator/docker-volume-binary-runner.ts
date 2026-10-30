import { spawn } from 'node:child_process';
import { fixedDockerVolumeInvocation } from '../../runtime/investigation-recovery.js';

export interface DockerBinaryResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  truncated: boolean;
}
export type DockerBinaryRunner = (args: string[], stdin?: Buffer) => Promise<DockerBinaryResult>;

const outputLimit = 128 * 1024 * 1024;
const errorLimit = 16 * 1024;

/** Binary, bounded Docker CLI transport on the fixed local daemon endpoint. */
export const runDockerVolumeBinary: DockerBinaryRunner = (args, stdin) => new Promise((resolve, reject) => {
  if (!Array.isArray(args) || args.length < 1 || args.some(arg => typeof arg !== 'string' ||
      arg.length > 4096 || arg.includes('\0')) || (stdin && (!Buffer.isBuffer(stdin) || stdin.length > outputLimit))) {
    reject(new Error('INVALID_ARGUMENT'));
    return;
  }
  const fixed = fixedDockerVolumeInvocation(args, process.env);
  const child = spawn('docker', fixed.args, { env: fixed.environment, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  let truncated = false;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
  child.stdout.on('data', (chunk: Buffer) => {
    outBytes += chunk.length;
    if (outBytes > outputLimit) { truncated = true; child.kill(); }
    else stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errBytes += chunk.length;
    if (errBytes > errorLimit) { truncated = true; child.kill(); }
    else stderr.push(chunk);
  });
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => {
    clearTimeout(timer);
    resolve({ exitCode: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
      timedOut, truncated });
  });
  child.stdin.on('error', () => { /* close and exit status report failed input transfer */ });
  child.stdin.end(stdin);
});
