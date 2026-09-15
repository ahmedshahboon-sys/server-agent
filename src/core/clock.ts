import type { Clock } from './interfaces.js';

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}
