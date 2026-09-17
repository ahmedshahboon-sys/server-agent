import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { CommandTimeoutError } from '../core/errors.js';
import { REDACTED, redactString } from '../security/redaction.js';

export interface ProcessExecutionOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly secretValues?: readonly string[];
  readonly onSpawn?: (pid: number | undefined) => void;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
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

function boundedAppend(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>, limit: number): { buffer: Buffer<ArrayBufferLike>; accepted: Buffer<ArrayBufferLike>; truncated: boolean } {
  if (current.length >= limit) return { buffer: current, accepted: Buffer.alloc(0), truncated: true };
  const remaining = limit - current.length;
  const accepted = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  return { buffer: Buffer.concat([current, accepted]), accepted, truncated: chunk.length > remaining };
}

const PRIVATE_KEY_BEGIN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i;
const PRIVATE_KEY_END = /-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/i;

class SafeStreamingRedactor {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private insidePrivateKey = false;
  public constructor(private readonly secrets: readonly string[]) {}

  public push(chunk: Buffer<ArrayBufferLike>): string {
    this.pending += this.decoder.write(chunk);
    return this.drain(false);
  }

  public flush(): string {
    this.pending += this.decoder.end();
    return this.drain(true);
  }

  private drain(flush: boolean): string {
    let output = '';
    while (true) {
      const newline = this.pending.indexOf('\n');
      if (newline < 0 && !flush) break;
      if (this.pending.length === 0) break;
      const take = newline < 0 ? this.pending.length : newline + 1;
      const line = this.pending.slice(0, take);
      this.pending = this.pending.slice(take);
      if (this.insidePrivateKey) {
        if (PRIVATE_KEY_END.test(line)) this.insidePrivateKey = false;
        continue;
      }
      if (PRIVATE_KEY_BEGIN.test(line)) {
        const endsHere = PRIVATE_KEY_END.test(line);
        this.insidePrivateKey = !endsHere;
        output += line.endsWith('\n') ? `${REDACTED}\n` : REDACTED;
        continue;
      }
      output += redactString(line, this.secrets);
    }
    if (flush && this.insidePrivateKey) {
      this.pending = '';
      this.insidePrivateKey = false;
    }
    return output;
  }
}

export async function executeArgv(argv: readonly string[], options: ProcessExecutionOptions): Promise<ProcessExecutionResult> {
  if (argv.length === 0) throw new Error('argv must not be empty');
  const [executable, ...args] = argv;
  if (executable === undefined) throw new Error('argv must not be empty');

  return new Promise<ProcessExecutionResult>((resolve, reject) => {
    const started = Date.now();
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let callbackError: unknown;
    const secrets = options.secretValues ?? [];
    const stdoutRedactor = new SafeStreamingRedactor(secrets);
    const stderrRedactor = new SafeStreamingRedactor(secrets);

    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    options.onSpawn?.(child.pid);

    const terminate = (): void => {
      if (settled) return;
      child.kill('SIGTERM');
      if (killTimer === undefined) {
        killTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 1000);
        killTimer.unref();
      }
    };
    const emit = (callback: ((chunk: string) => void) | undefined, chunk: string): void => {
      if (callback === undefined || chunk === '') return;
      try { callback(chunk); }
      catch (error) { callbackError = error; terminate(); }
    };
    const flushStreams = (): void => {
      emit(options.onStdout, stdoutRedactor.flush());
      emit(options.onStderr, stderrRedactor.flush());
    };

    const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
    timer.unref();
    const abort = (): void => { terminate(); };
    if (options.signal?.aborted === true) terminate();
    else options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: Buffer<ArrayBufferLike>) => {
      const next = boundedAppend(stdout, chunk, options.maxOutputBytes);
      stdout = next.buffer;
      stdoutTruncated ||= next.truncated;
      emit(options.onStdout, stdoutRedactor.push(next.accepted));
    });
    child.stderr.on('data', (chunk: Buffer<ArrayBufferLike>) => {
      const next = boundedAppend(stderr, chunk, options.maxOutputBytes);
      stderr = next.buffer;
      stderrTruncated ||= next.truncated;
      emit(options.onStderr, stderrRedactor.push(next.accepted));
    });

    child.once('error', (error) => {
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      flushStreams();
      reject(callbackError ?? error);
    });

    child.once('close', (exitCode, signal) => {
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      flushStreams();
      if (callbackError !== undefined) { reject(callbackError); return; }
      if (timedOut) {
        reject(new CommandTimeoutError(`Command timed out after ${options.timeoutMs}ms`));
        return;
      }
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
