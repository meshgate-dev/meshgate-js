/**
 * Structured logger for @meshgate/sdk internal diagnostics.
 *
 * SECURITY: never log args, keys, hashes, iv, ciphertext, apiKey, or masterSecret.
 * Only log structural metadata (intent name, approvalId, event type, log level).
 */

const LOG_LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const;
export type LogLevel = keyof typeof LOG_LEVEL_ORDER;

export interface Logger {
  debug(event: string, meta?: Record<string, unknown>): void;
  info(event: string, meta?: Record<string, unknown>): void;
  warn(event: string, meta?: Record<string, unknown>): void;
  error(event: string, meta?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel): Logger {
  const minLevel = LOG_LEVEL_ORDER[level];

  function emit(msgLevel: LogLevel, event: string, meta: Record<string, unknown> = {}): void {
    if (LOG_LEVEL_ORDER[msgLevel] < minLevel) return;
    if (msgLevel === 'warn') {
      console.warn('[meshgate]', event, meta);
    } else if (msgLevel === 'error') {
      console.error('[meshgate]', event, meta);
    } else {
      console.log('[meshgate]', event, meta);
    }
  }

  return {
    debug: (event, meta) => emit('debug', event, meta),
    info: (event, meta) => emit('info', event, meta),
    warn: (event, meta) => emit('warn', event, meta),
    error: (event, meta) => emit('error', event, meta),
  };
}
