import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ValidationError, assertIdentifier, assertPlainObject, assertSafeFilename } from './schema.js';

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function cleanOptionalString(value, name, maxLength = 500) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new ValidationError(`${name} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

export function validateAuditEvent(input) {
  assertPlainObject(input, 'audit event');
  const action = cleanOptionalString(input.action, 'audit action', 128);
  if (!action || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(action)) {
    throw new ValidationError('audit action is invalid');
  }
  const memorialId = input.memorialId === undefined ? undefined : assertIdentifier(input.memorialId, 'audit memorialId');
  const actor = cleanOptionalString(input.actor, 'audit actor', 200);
  const requestId = cleanOptionalString(input.requestId, 'audit requestId', 128);
  const outcome = input.outcome === undefined ? 'success' : cleanOptionalString(input.outcome, 'audit outcome', 64);
  const event = {
    id: input.id === undefined ? crypto.randomUUID() : assertIdentifier(input.id, 'audit id'),
    timestamp: input.timestamp === undefined ? new Date().toISOString() : cleanOptionalString(input.timestamp, 'audit timestamp', 64),
    action,
    outcome
  };
  if (memorialId) event.memorialId = memorialId;
  if (actor) event.actor = actor;
  if (requestId) event.requestId = requestId;
  if (input.details !== undefined) {
    assertPlainObject(input.details, 'audit details');
    event.details = structuredClone(input.details);
  }
  return event;
}

export class AuditLog {
  constructor(options = {}) {
    if (typeof options === 'string') options = { auditPath: options };
    assertPlainObject(options, 'options');
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
    this.auditPath = path.resolve(options.auditPath || path.join(dataDir, 'audit.jsonl'));
    if (this.auditPath === dataDir || !this.auditPath.startsWith(`${dataDir}${path.sep}`)) {
      throw new ValidationError('auditPath must remain inside dataDir');
    }
    assertSafeFilename(path.basename(this.auditPath), 'audit filename');
    this.writeQueue = Promise.resolve();
  }

  async append(input) {
    const event = validateAuditEvent(input);
    const serialized = `${JSON.stringify(event)}\n`;
    const run = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.auditPath), { recursive: true });
      await fs.appendFile(this.auditPath, serialized, { encoding: 'utf8', mode: 0o600 });
      return structuredClone(event);
    });
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  async list({ memorialId, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new ValidationError('audit limit must be an integer from 1 to 1000');
    }
    const id = memorialId === undefined ? undefined : assertIdentifier(memorialId, 'memorialId');
    try {
      const content = await fs.readFile(this.auditPath, 'utf8');
      const events = [];
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new ValidationError('data/audit.jsonl contains invalid JSONL');
        }
        const event = validateAuditEvent(parsed);
        if (!id || event.memorialId === id) events.push(event);
      }
      return events.slice(-limit).map((event) => structuredClone(event));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
}

export async function appendAudit(storeOrOptions, input) {
  if (storeOrOptions?.append && typeof storeOrOptions.append === 'function') {
    return storeOrOptions.append(input);
  }
  return new AuditLog(storeOrOptions).append(input);
}
