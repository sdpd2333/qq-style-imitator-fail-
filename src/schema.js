import path from 'node:path';
import crypto from 'node:crypto';

export const AUTHORIZATION_STATUSES = Object.freeze([
  'pending',
  'approved',
  'suspended',
  'revoked',
  'deleted'
]);

const STATUS_SET = new Set(AUTHORIZATION_STATUSES);
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

export class ValidationError extends TypeError {
  constructor(message, details = []) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'ERR_INVALID_INPUT';
    this.details = details;
  }
}

export function assertPlainObject(value, name = 'value') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${name} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ValidationError(`${name} must be a plain object`);
  }
  return value;
}

export function assertNonEmptyString(value, name, { maxLength = 256 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new ValidationError(`${name} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

export function assertSafeFilename(filename, name = 'filename') {
  if (typeof filename !== 'string' || !filename || filename !== path.basename(filename) ||
      filename.includes('\0') || filename === '.' || filename === '..' ||
      filename.endsWith('.') || filename.endsWith(' ') || !SAFE_FILENAME.test(filename) ||
      WINDOWS_RESERVED.test(filename)) {
    throw new ValidationError(`${name} is not a safe filename`);
  }
  return filename;
}

export function assertIdentifier(value, name = 'id') {
  return assertSafeFilename(assertNonEmptyString(value, name, { maxLength: 128 }), name);
}

export function validateStatus(status, name = 'status') {
  if (typeof status !== 'string' || !STATUS_SET.has(status)) {
    throw new ValidationError(`${name} must be one of: ${AUTHORIZATION_STATUSES.join(', ')}`);
  }
  return status;
}

function normaliseBoolean(value, name, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && typeof value.enabled === 'boolean' &&
      Object.keys(value).every((key) => key === 'enabled')) return value.enabled;
  throw new ValidationError(`${name} must be a boolean or { enabled: boolean }`);
}

export function validateGroupIds(groupIds, { required = true } = {}) {
  if (!Array.isArray(groupIds)) throw new ValidationError('scope.groupIds must be an array');
  if (required && groupIds.length === 0) throw new ValidationError('scope.groupIds must not be empty');
  if (groupIds.length > 1000) throw new ValidationError('scope.groupIds has too many entries');
  const result = [...new Set(groupIds.map((groupId, index) => {
    if (typeof groupId !== 'string' && typeof groupId !== 'number') {
      throw new ValidationError(`scope.groupIds[${index}] must be a string or number`);
    }
    const value = String(groupId).trim();
    if (!/^[0-9A-Za-z_-]{1,128}$/u.test(value)) {
      throw new ValidationError(`scope.groupIds[${index}] is invalid`);
    }
    return value;
  }))];
  return result;
}

export function validateIdentityDisclosure(value = {}) {
  if (value === false) return { enabled: false, text: '' };
  if (value === true) return { enabled: true, text: '这是纪念账号生成的回复，不代表本人。' };
  assertPlainObject(value, 'identityDisclosure');
  const allowed = new Set(['enabled', 'text']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ValidationError(`identityDisclosure contains unsupported fields: ${unknown.join(', ')}`);
  const enabled = value.enabled === undefined ? false : value.enabled;
  if (typeof enabled !== 'boolean') throw new ValidationError('identityDisclosure.enabled must be a boolean');
  const text = value.text === undefined ? '' : (enabled
    ? assertNonEmptyString(value.text, 'identityDisclosure.text', { maxLength: 500 })
    : String(value.text || '').trim());
  if (text.length > 500) throw new ValidationError('identityDisclosure.text must be at most 500 characters');
  if (enabled && !text) throw new ValidationError('identityDisclosure.text is required when enabled');
  return { enabled, text };
}

function validateSwitch(value, name, defaultValue = false) {
  return { enabled: normaliseBoolean(value, name, defaultValue) };
}

export function normalizeMemorial(input, { requireId = false } = {}) {
  assertPlainObject(input, 'memorial');
  const id = input.id === undefined && !requireId ? crypto.randomUUID() : assertIdentifier(input.id, 'memorial.id');
  const scopeInput = input.scope === undefined ? {} : input.scope;
  assertPlainObject(scopeInput, 'scope');
  const groupIds = validateGroupIds(scopeInput.groupIds ?? input.groupIds ?? [], { required: false });
  const authorization = input.authorization === undefined ? {} : input.authorization;
  if (authorization === null || typeof authorization !== 'object' || Array.isArray(authorization)) {
    throw new ValidationError('authorization must be an object');
  }
  if (input.status !== undefined && authorization.status !== undefined && input.status !== authorization.status) {
    throw new ValidationError('memorial.status and authorization.status must match');
  }
  const status = validateStatus(input.status ?? authorization.status ?? 'pending');
  const runtime = validateSwitch(input.runtime, 'runtime');
  const participation = validateSwitch(input.participation, 'participation');
  const identityDisclosure = validateIdentityDisclosure(input.identityDisclosure);
  const now = new Date().toISOString();
  const createdAt = input.createdAt === undefined ? now : assertNonEmptyString(input.createdAt, 'createdAt', { maxLength: 64 });
  const updatedAt = input.updatedAt === undefined ? createdAt : assertNonEmptyString(input.updatedAt, 'updatedAt', { maxLength: 64 });
  const subject = input.subject === undefined ? {} : input.subject;
  if (subject !== null && (typeof subject !== 'object' || Array.isArray(subject))) {
    throw new ValidationError('subject must be an object');
  }
  const result = {
    id,
    name: input.name === undefined ? id : assertNonEmptyString(input.name, 'memorial.name', { maxLength: 200 }),
    subject: subject || {},
    authorization: { status },
    status,
    scope: { groupIds },
    identityDisclosure,
    runtime,
    participation,
    createdAt,
    updatedAt
  };
  if (input.metadata !== undefined) {
    assertPlainObject(input.metadata, 'metadata');
    result.metadata = structuredClone(input.metadata);
  }
  return result;
}

export function validateMemorial(input, options = {}) {
  return normalizeMemorial(input, options);
}

export function isApprovedFor(groupId, memorial) {
  if (!memorial || memorial.status !== 'approved' || memorial.authorization?.status !== 'approved') return false;
  if (!memorial.runtime?.enabled || !memorial.participation?.enabled) return false;
  if (groupId === undefined || groupId === null) return false;
  return memorial.scope?.groupIds?.includes(String(groupId)) === true;
}

export function resolveDataPath(rootDir, relativePath) {
  const root = path.resolve(rootDir);
  const relative = assertSafeFilename(relativePath, 'path');
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new ValidationError('path escapes data directory');
  }
  return resolved;
}
