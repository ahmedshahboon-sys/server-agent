import net from 'node:net';
import path from 'node:path';
import { ValidationError } from '../core/errors.js';

export type HostControlAction = 'status' | 'restart' | 'logs';

export interface HostControlResponse {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
}

export async function requestHostControl(
  socketPath: string,
  action: HostControlAction,
  serviceName: string,
  lines?: number,
  timeoutMs = 15_000,
  maxResponseBytes = 524_288,
): Promise<HostControlResponse> {
  if (!path.isAbsolute(socketPath) || socketPath.includes('\0')) throw new ValidationError('Host helper socket path must be absolute');
  if (!/^[A-Za-z0-9@_.:-]{1,128}\.service$/.test(serviceName)) throw new ValidationError('Invalid systemd service name');
  if (action === 'logs' && (!Number.isInteger(lines) || (lines ?? 0) < 1 || (lines ?? 0) > 2000)) throw new ValidationError('Host helper log line count must be 1-2000');

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== undefined) reject(error);
    };
    const timer = setTimeout(() => finish(new ValidationError('Host helper request timed out')), timeoutMs);
    timer.unref();

    socket.once('connect', () => {
      socket.end(`${JSON.stringify({ action, serviceName, ...(lines === undefined ? {} : { lines }) })}\n`);
    });
    socket.on('data', (chunk) => {
      const data = Buffer.from(chunk);
      bytes += data.length;
      if (bytes > maxResponseBytes) {
        finish(new ValidationError('Host helper response exceeded the allowed size'));
        return;
      }
      chunks.push(data);
    });
    socket.once('error', (error) => finish(new ValidationError('Host helper connection failed', { message: error.message })));
    socket.once('end', () => {
      if (settled) return;
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
      catch { finish(new ValidationError('Host helper returned invalid JSON')); return; }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { finish(new ValidationError('Host helper returned invalid response')); return; }
      const row = parsed as Record<string, unknown>;
      if (typeof row['ok'] !== 'boolean' || typeof row['exitCode'] !== 'number' || typeof row['stdout'] !== 'string' || typeof row['stderr'] !== 'string') {
        finish(new ValidationError('Host helper returned invalid response'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: row['ok'],
        exitCode: row['exitCode'],
        stdout: row['stdout'],
        stderr: row['stderr'],
        ...(typeof row['stdoutTruncated'] === 'boolean' ? { stdoutTruncated: row['stdoutTruncated'] } : {}),
        ...(typeof row['stderrTruncated'] === 'boolean' ? { stderrTruncated: row['stderrTruncated'] } : {}),
      });
    });
  });
}
