import type { Logger } from '../core/interfaces.js';
import type { LogLevel } from '../config/config.js';
import { redactValue } from '../security/redaction.js';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface StructuredLogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export type LogSink = (record: StructuredLogRecord) => void;

export class StructuredLogger implements Logger {
  public constructor(
    private readonly minimumLevel: LogLevel,
    private readonly sink: LogSink = (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
  ) {}

  public debug(message: string, context?: Readonly<Record<string, unknown>>): void { this.write('debug', message, context); }
  public info(message: string, context?: Readonly<Record<string, unknown>>): void { this.write('info', message, context); }
  public warn(message: string, context?: Readonly<Record<string, unknown>>): void { this.write('warn', message, context); }
  public error(message: string, context?: Readonly<Record<string, unknown>>): void { this.write('error', message, context); }

  private write(level: LogLevel, message: string, context?: Readonly<Record<string, unknown>>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minimumLevel]) return;
    const record: StructuredLogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message: redactValue(message),
      ...(context === undefined ? {} : { context: redactValue(context) }),
    };
    this.sink(record);
  }
}
