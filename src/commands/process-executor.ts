import { spawn } from 'node:child_process';
import { CommandTimeoutError } from '../core/errors.js';
import { redactString } from '../security/redaction.js';

export interface ProcessExecutionOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly secretValues?: readonly string[];
  readonly onSpawn?: (pid: number | undefined) => void;
}

export interface ProcessExecutionResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

function boundedAppend(current: Buffer, chunk: Buffer, limit: number): { buffer: Buffer; truncated: boolean } {
  if (current.length >= limit) return { buffer: current, truncated: true };
  const remaining = limit - current.length;
  if (chunk.length <= remaining) return { buffer: Buffer.concat([current, chunk]), truncated: false };
  return { buffer: Buffer.concat([current, chunk.subarray(0, remaining)]), truncated: true };
}

export async function executeArgv(argv: readonly string[], options: ProcessExecutionOptions): Promise<ProcessExecutionResult> {
  if (argv.length === 0) throw new Error('argv must not be empty');
  const [executable, ...args] = argv;
  if (executable === undefined) throw new Error('argv must not be empty');

  return new Promise<ProcessExecutionResult>((resolve, reject) => {
    const started = Date.now();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    options.onSpawn?.(child.pid);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 1000).unref();
    }, options.timeoutMs);
    timer.unref();

    const abort = (): void => { child.kill('SIGTERM'); };
    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      const next = boundedAppend(stdout, chunk, options.maxOutputBytes);
      stdout = next.buffer;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const next = boundedAppend(stderr, chunk, options.maxOutputBytes);
      stderr = next.buffer;
      stderrTruncated ||= next.truncated;
    });

    child.once('error', (error) => {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });

    child.once('close', (exitCode, signal) => {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (timedOut) {
        reject(new CommandTimeoutError(`Command timed out after ${options.timeoutMs}ms`));
        return;
      }
      const secrets = options.secretValues ?? [];
      resolve({
        exitCode,
        signal,
        stdout: redactString(stdout.toString('utf8'), secrets),
        stderr: redactString(stderr.toString('utf8'), secrets),
        stdoutTruncated,
        stderrTruncated,
        durationMs: Date.now() - started,
      });
    });
  });
}
