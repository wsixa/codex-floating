import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export class Logger {
  private queue: Promise<void> = Promise.resolve();
  private readonly filePath: string;
  constructor(filePath?: string) { this.filePath = filePath ?? path.join(app.getPath('logs'), 'codex-floating-assistant.log'); }
  debug(message: string, context?: unknown): void { this.write('debug', message, context); }
  info(message: string, context?: unknown): void { this.write('info', message, context); }
  warn(message: string, context?: unknown): void { this.write('warn', message, context); }
  error(message: string, context?: unknown): void { this.write('error', message, context); }
  private write(level: LogLevel, message: string, context?: unknown): void {
    const entry = { timestamp: new Date().toISOString(), level, message: redact(String(message)).slice(0, 2000), ...(context === undefined ? {} : { context: redactValue(context) }) };
    const line = JSON.stringify(entry) + String.fromCharCode(10);
    this.queue = this.queue.catch(() => undefined).then(async () => { await fs.mkdir(path.dirname(this.filePath), { recursive: true }); await fs.appendFile(this.filePath, line, 'utf8'); });
  }
}
function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value).slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 32).map(redactValue);
  if (value && typeof value === 'object') { const result: Record<string, unknown> = {}; for (const [key,item] of Object.entries(value as Record<string, unknown>)) result[key] = /(token|secret|password|passwd|authorization|api[-_]?key|cookie|prompt|response)/i.test(key) ? '[redacted]' : redactValue(item); return result; }
  return value;
}
function redact(value: string): string { return value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/(?:sk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted-key]').replace(/https?:\/\/[^\s)]+/gi, '[redacted-url]'); }
