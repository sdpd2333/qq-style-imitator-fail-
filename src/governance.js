import { AuditLog } from './audit.js';
import { MemoryStore } from './memory-store.js';
import { ValidationError, assertIdentifier, isApprovedFor, validateStatus } from './schema.js';

const TRANSITIONS = Object.freeze({
  pending: new Set(['approved', 'suspended', 'revoked', 'deleted']),
  approved: new Set(['suspended', 'revoked', 'deleted']),
  suspended: new Set(['approved', 'revoked', 'deleted']),
  revoked: new Set(['deleted']),
  deleted: new Set()
});

function rejection(reason, memorial = null) {
  return { allowed: false, reason, memorial };
}

export class GovernanceService {
  constructor(options = {}) {
    if (options instanceof MemoryStore) options = { store: options };
    this.store = options.store || new MemoryStore(options);
    this.audit = options.audit || new AuditLog({
      dataDir: this.store.dataDir,
      auditPath: options.auditPath || this.store.auditPath
    });
  }

  async initialize() {
    await this.store.init();
    return this;
  }

  async createMemorial(input, { actor, requestId } = {}) {
    const memorial = await this.store.createMemorial(input);
    await this.#audit('memorial.created', memorial.id, { actor, requestId, details: { status: memorial.status } });
    return memorial;
  }

  async getMemorial(memorialId, options) {
    return this.store.getMemorial(memorialId, options);
  }

  async saveMemorial(memorial, { actor, requestId } = {}) {
    const saved = await this.store.saveMemorial(memorial);
    await this.#audit('memorial.saved', saved.id, { actor, requestId, details: { status: saved.status } });
    return saved;
  }

  async changeStatus(memorialId, status, { actor, requestId, reason } = {}) {
    const id = assertIdentifier(memorialId, 'memorialId');
    const nextStatus = validateStatus(status);
    const current = await this.store.getMemorial(id, { includeDeleted: true });
    if (!current) throw new ValidationError(`memorial does not exist: ${id}`);
    if (current.status === nextStatus) return current;
    if (!TRANSITIONS[current.status]?.has(nextStatus)) {
      throw new ValidationError(`cannot transition memorial from ${current.status} to ${nextStatus}`);
    }
    const forceDisabled = nextStatus !== 'approved';
    const updated = await this.store.updateMemorial(id, {
      status: nextStatus,
      authorization: { status: nextStatus },
      ...(forceDisabled ? { runtime: { enabled: false }, participation: { enabled: false } } : {})
    });
    await this.#audit('authorization.status_changed', id, {
      actor,
      requestId,
      details: { from: current.status, to: nextStatus, reason: reason || undefined }
    });
    return updated;
  }

  async authorize(input) {
    const request = typeof input === 'object' && input !== null ? input : {};
    return this.changeStatus(request.memorialId, 'approved', request);
  }

  async suspend(input) {
    const request = typeof input === 'object' && input !== null ? input : {};
    return this.changeStatus(request.memorialId, 'suspended', request);
  }

  async revoke(input) {
    const request = typeof input === 'object' && input !== null ? input : {};
    return this.changeStatus(request.memorialId, 'revoked', request);
  }

  async canParticipate({ memorialId, groupId } = {}) {
    if (memorialId === undefined || groupId === undefined || groupId === null) {
      return rejection('missing_scope');
    }
    let id;
    try {
      id = assertIdentifier(memorialId, 'memorialId');
    } catch (error) {
      if (error instanceof ValidationError) return rejection('invalid_memorial_id');
      throw error;
    }
    const memorial = await this.store.getMemorial(id);
    if (!memorial) return rejection('memorial_not_found');
    if (memorial.status !== 'approved' || memorial.authorization?.status !== 'approved') {
      return rejection('authorization_not_approved', memorial);
    }
    if (!memorial.runtime?.enabled) return rejection('runtime_disabled', memorial);
    if (!memorial.participation?.enabled) return rejection('participation_disabled', memorial);
    if (!memorial.scope?.groupIds?.includes(String(groupId))) return rejection('group_not_authorized', memorial);
    if (!isApprovedFor(groupId, memorial)) return rejection('policy_denied', memorial);
    return { allowed: true, reason: null, memorial };
  }

  async assertCanParticipate(context) {
    const decision = await this.canParticipate(context);
    if (!decision.allowed) throw new ValidationError(`participation denied: ${decision.reason}`);
    return decision.memorial;
  }

  async cascadeDelete(memorialId, { actor, requestId, hardDelete = false, reason } = {}) {
    const id = assertIdentifier(memorialId, 'memorialId');
    const existing = await this.store.getMemorial(id, { includeDeleted: true });
    if (!existing) return null;
    const deletedSamples = await this.store.deleteSamples(id);
    const memorial = await this.store.deleteMemorial(id, { hardDelete });
    await this.#audit('memorial.deleted', id, {
      actor,
      requestId,
      details: { hardDelete, deletedSamples, reason: reason || undefined }
    });
    return { memorial, deletedSamples, hardDelete };
  }

  async #audit(action, memorialId, { actor, requestId, details } = {}) {
    return this.audit.append({
      action,
      memorialId,
      actor,
      requestId,
      details
    });
  }
}

export { TRANSITIONS as AUTHORIZATION_TRANSITIONS };
