import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ValidationError,
  assertIdentifier,
  assertPlainObject,
  assertSafeFilename,
  normalizeMemorial,
  validateMemorial
} from './schema.js';

const EMPTY_MEMORIALS = Object.freeze({ version: 1, memorials: [] });

function clone(value) {
  return structuredClone(value);
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function safeSampleFileName(memorialId, sampleId) {
  return `${assertIdentifier(memorialId, 'memorialId')}--${assertIdentifier(sampleId, 'sampleId')}.json`;
}

export class MemoryStore {
  constructor(options = {}) {
    if (typeof options === 'string') options = { dataDir: options };
    assertPlainObject(options, 'options');
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
    this.dataDir = dataDir;
    this.memorialsPath = path.resolve(options.memorialsPath || path.join(dataDir, 'memorials.json'));
    this.auditPath = path.resolve(options.auditPath || path.join(dataDir, 'audit.jsonl'));
    this.samplesDir = path.resolve(options.samplesDir || path.join(dataDir, 'samples'));
    for (const target of [this.memorialsPath, this.auditPath, this.samplesDir]) {
      if (target === dataDir || !target.startsWith(`${dataDir}${path.sep}`)) {
        throw new ValidationError('storage paths must remain inside dataDir');
      }
    }
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(this.samplesDir, { recursive: true });
    try {
      await fs.access(this.memorialsPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await this.#writeJsonAtomic(this.memorialsPath, EMPTY_MEMORIALS);
    }
    return this;
  }

  async listMemorials({ includeDeleted = false } = {}) {
    const document = await this.#readMemorialDocument();
    return clone(document.memorials.filter((item) => includeDeleted || item.status !== 'deleted'));
  }

  async getMemorial(memorialId, { includeDeleted = false } = {}) {
    const id = assertIdentifier(memorialId, 'memorialId');
    const document = await this.#readMemorialDocument();
    const memorial = document.memorials.find((item) => item.id === id);
    if (!memorial || (!includeDeleted && memorial.status === 'deleted')) return null;
    return clone(memorial);
  }

  async createMemorial(input) {
    const memorial = normalizeMemorial(input);
    return this.#withWrite(async () => {
      const document = await this.#readMemorialDocument();
      if (document.memorials.some((item) => item.id === memorial.id)) {
        throw new ValidationError(`memorial already exists: ${memorial.id}`);
      }
      document.memorials.push(memorial);
      await this.#writeJsonAtomic(this.memorialsPath, document);
      return clone(memorial);
    });
  }

  async saveMemorial(input, { requireExisting = true } = {}) {
    const memorial = validateMemorial(input, { requireId: true });
    return this.#withWrite(async () => {
      const document = await this.#readMemorialDocument();
      const index = document.memorials.findIndex((item) => item.id === memorial.id);
      if (index === -1 && requireExisting) throw new ValidationError(`memorial does not exist: ${memorial.id}`);
      const existing = index === -1 ? null : document.memorials[index];
      memorial.createdAt = existing?.createdAt || memorial.createdAt;
      memorial.updatedAt = new Date().toISOString();
      if (index === -1) document.memorials.push(memorial);
      else document.memorials[index] = memorial;
      await this.#writeJsonAtomic(this.memorialsPath, document);
      return clone(memorial);
    });
  }

  async updateMemorial(memorialId, patch) {
    const id = assertIdentifier(memorialId, 'memorialId');
    assertPlainObject(patch, 'patch');
    return this.#withWrite(async () => {
      const document = await this.#readMemorialDocument();
      const index = document.memorials.findIndex((item) => item.id === id);
      if (index === -1) throw new ValidationError(`memorial does not exist: ${id}`);
      const current = document.memorials[index];
      const merged = {
        ...current,
        ...clone(patch),
        id,
        authorization: { ...current.authorization, ...patch.authorization },
        scope: { ...current.scope, ...patch.scope },
        runtime: { ...current.runtime, ...patch.runtime },
        participation: { ...current.participation, ...patch.participation },
        identityDisclosure: { ...current.identityDisclosure, ...patch.identityDisclosure },
        updatedAt: new Date().toISOString()
      };
      const memorial = validateMemorial(merged, { requireId: true });
      document.memorials[index] = memorial;
      await this.#writeJsonAtomic(this.memorialsPath, document);
      return clone(memorial);
    });
  }

  async writeSample(memorialId, sampleId, input) {
    const id = assertIdentifier(memorialId, 'memorialId');
    const sample = assertIdentifier(sampleId, 'sampleId');
    assertPlainObject(input, 'sample');
    const memorial = await this.getMemorial(id);
    if (!memorial) throw new ValidationError(`active memorial does not exist: ${id}`);
    const filePath = this.#samplePath(id, sample);
    const payload = { ...clone(input), id: sample, memorialId: id, updatedAt: new Date().toISOString() };
    await this.#withWrite(() => this.#writeJsonAtomic(filePath, payload));
    return clone(payload);
  }

  async readSample(memorialId, sampleId) {
    const filePath = this.#samplePath(memorialId, sampleId);
    try {
      const text = await fs.readFile(filePath, 'utf8');
      const value = JSON.parse(text);
      assertPlainObject(value, 'stored sample');
      return clone(value);
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof SyntaxError) throw new ValidationError(`invalid JSON in sample ${path.basename(filePath)}`);
      throw error;
    }
  }

  async listSamples(memorialId) {
    const id = assertIdentifier(memorialId, 'memorialId');
    await this.init();
    const prefix = `${id}--`;
    const names = await fs.readdir(this.samplesDir, { withFileTypes: true });
    const samples = [];
    for (const entry of names) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.json')) continue;
      const filename = assertSafeFilename(entry.name, 'sample filename');
      const sample = await this.readSample(id, filename.slice(prefix.length, -'.json'.length));
      if (sample) samples.push(sample);
    }
    return samples;
  }

  async deleteSample(memorialId, sampleId) {
    const filePath = this.#samplePath(memorialId, sampleId);
    return this.#withWrite(async () => {
      try {
        await fs.unlink(filePath);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    });
  }

  async deleteSamples(memorialId) {
    const id = assertIdentifier(memorialId, 'memorialId');
    return this.#withWrite(async () => {
      await fs.mkdir(this.samplesDir, { recursive: true });
      const prefix = `${id}--`;
      const entries = await fs.readdir(this.samplesDir, { withFileTypes: true });
      const candidates = entries.filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.json'));
      await Promise.all(candidates.map((entry) => fs.unlink(path.join(this.samplesDir, assertSafeFilename(entry.name, 'sample filename')))));
      return candidates.length;
    });
  }

  async deleteMemorial(memorialId, { hardDelete = false } = {}) {
    const id = assertIdentifier(memorialId, 'memorialId');
    return this.#withWrite(async () => {
      const document = await this.#readMemorialDocument();
      const index = document.memorials.findIndex((item) => item.id === id);
      if (index === -1) return null;
      const current = document.memorials[index];
      let result;
      if (hardDelete) {
        [result] = document.memorials.splice(index, 1);
      } else {
        result = validateMemorial({
          ...current,
          status: 'deleted',
          authorization: { ...current.authorization, status: 'deleted' },
          runtime: { enabled: false },
          participation: { enabled: false },
          updatedAt: new Date().toISOString()
        }, { requireId: true });
        document.memorials[index] = result;
      }
      await this.#writeJsonAtomic(this.memorialsPath, document);
      return clone(result);
    });
  }

  #samplePath(memorialId, sampleId) {
    return path.join(this.samplesDir, safeSampleFileName(memorialId, sampleId));
  }

  async #readMemorialDocument() {
    await this.init();
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.memorialsPath, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) throw new ValidationError('data/memorials.json contains invalid JSON');
      throw error;
    }
    const memorials = Array.isArray(parsed) ? parsed : parsed?.memorials;
    if (!Array.isArray(memorials)) throw new ValidationError('data/memorials.json must contain a memorials array');
    return { version: Number.isInteger(parsed?.version) ? parsed.version : 1, memorials: memorials.map((item) => validateMemorial(item, { requireId: true })) };
  }

  async #withWrite(action) {
    const run = this.writeQueue.then(action, action);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  async #writeJsonAtomic(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tempPath, filePath);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}
