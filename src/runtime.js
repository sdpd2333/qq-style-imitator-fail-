import { normalizeOneBotMessage, isGroupMessage } from './message-normalizer.js';
import { ParticipationPolicy } from './participation-policy.js';

export class MemorialRuntime {
  constructor({ client, governance, replyEngine, profileLoader, memorialResolver, policy, audit } = {}) {
    if (!client || !governance || !replyEngine) throw new TypeError('client, governance and replyEngine are required');
    this.client = client;
    this.governance = governance;
    this.replyEngine = replyEngine;
    this.profileLoader = profileLoader || (async () => ({}));
    this.memorialResolver = memorialResolver || ((event) => event.memorial_id || event.memorialId || null);
    this.policy = policy || new ParticipationPolicy();
    this.audit = audit;
    this.seen = new Set();
    this.unsubscribe = null;
    this.running = false;
  }

  async start() {
    if (this.running) return;
    await this.client.connect();
    this.unsubscribe = this.client.onEvent((event) => this.handleEvent(event));
    this.running = true;
  }

  stop() {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.client.disconnect();
  }

  async handleEvent(event) {
    if (!this.running || !isGroupMessage(event)) return { sent: false, reason: 'runtime_stopped_or_not_group' };
    const message = normalizeOneBotMessage(event);
    if (!message || !message.id || this.seen.has(message.id)) return { sent: false, reason: 'duplicate_or_empty' };
    this.seen.add(message.id);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value);
    const memorialId = await this.memorialResolver(event);
    if (!memorialId) return { sent: false, reason: 'missing_memorial_mapping' };
    const decision = await this.governance.canParticipate({ memorialId, groupId: event.group_id });
    if (!decision.allowed) return this.#audit('runtime.denied', memorialId, { reason: decision.reason });
    const policy = this.policy.decide(event, { memorial: decision.memorial });
    if (!policy.allowed) return this.#audit('runtime.denied', memorialId, { reason: policy.reason });
    const profile = await this.profileLoader(memorialId);
    const result = await this.replyEngine.generate({
      userMessage: message.content,
      context: [message],
      profile,
      groupId: String(event.group_id),
      targetQQ: decision.memorial.subject?.qq,
      targetName: decision.memorial.name,
      identityDisclosure: decision.memorial.identityDisclosure,
      dryRun: false
    });
    const reply = result.acceptedCandidates?.[0];
    if (!reply) return this.#audit('runtime.suppressed', memorialId, { reasons: result.rejectionReasons || ['no_safe_candidate'] });
    if (result.disclosure?.enabled && !reply.includes(result.disclosure.text)) {
      return this.#audit('runtime.suppressed', memorialId, { reasons: ['missing_identity_disclosure'] });
    }
    await this.client.sendGroupMessage(event.group_id, reply);
    this.policy.recordSent(event.group_id);
    return this.#audit('runtime.sent', memorialId, { groupId: String(event.group_id), messageId: message.id });
  }

  async #audit(action, memorialId, details) {
    if (this.audit?.append) await this.audit.append({ action, memorialId, details });
    return { sent: action === 'runtime.sent', reason: details?.reason || details?.reasons?.[0] || null };
  }
}
