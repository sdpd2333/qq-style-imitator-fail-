const MODES = new Set(['mention_only', 'reply_to_bot', 'review_required', 'conservative_auto']);
const SENSITIVE = /(?:自杀|自残|轻生|死亡细节|遗言|医疗诊断|法律意见|转账|验证码|银行卡|身份证|住址|未成年人色情|性侵|强奸|仇恨|骚扰)/u;

export const PARTICIPATION_MODES = Object.freeze([...MODES]);

export class ParticipationPolicy {
  constructor(config = {}) {
    this.mode = MODES.has(config.mode) ? config.mode : 'mention_only';
    this.selfId = config.selfId ? String(config.selfId) : '';
    this.minIntervalMs = Math.max(0, Number(config.minIntervalMs ?? 60_000));
    this.maxPerHour = Math.max(1, Number(config.maxPerHour ?? 8));
    this.maxConsecutive = Math.max(1, Number(config.maxConsecutive ?? 2));
    this.lastSent = new Map();
    this.sent = new Map();
  }

  decide(event, { memorial, context = [] } = {}) {
    if (!event || event.post_type !== 'message' || event.message_type !== 'group') return this.deny('not_group_message');
    if (!memorial || memorial.status !== 'approved' || !memorial.runtime?.enabled || !memorial.participation?.enabled) return this.deny('memorial_disabled');
    if (!memorial.scope?.groupIds?.includes(String(event.group_id))) return this.deny('group_not_authorized');
    const senderId = String(event.sender?.user_id ?? '');
    if (this.selfId && senderId === this.selfId) return this.deny('self_message');
    const text = this.#text(event);
    if (!text) return this.deny('empty_message');
    if (SENSITIVE.test(text)) return this.deny('sensitive_topic');
    if (event.raw_message?.includes('[CQ:at,qq=all]')) return this.deny('all_mention');

    const groupId = String(event.group_id);
    const mentioned = Array.isArray(event.message)
      && event.message.some((part) => part?.type === 'at' && String(part.data?.qq) === this.selfId);
    const repliedToBot = event.message?.some((part) => part?.type === 'reply' && String(part.data?.user_id) === this.selfId);
    const shouldReply = this.mode === 'mention_only' ? mentioned : this.mode === 'reply_to_bot' ? (mentioned || repliedToBot) : (mentioned || repliedToBot || this.mode === 'conservative_auto');
    if (!shouldReply) return this.deny('not_triggered');

    const now = Date.now();
    const last = this.lastSent.get(groupId) || 0;
    if (now - last < this.minIntervalMs) return this.deny('cooldown');
    const hourly = (this.sent.get(groupId) || []).filter((time) => now - time < 3600000);
    if (hourly.length >= this.maxPerHour) return this.deny('hourly_limit');
    const lastMessages = context.slice(-this.maxConsecutive).filter((item) => String(item?.sender?.user_id ?? item?.qq ?? '') === this.selfId);
    if (lastMessages.length >= this.maxConsecutive) return this.deny('consecutive_limit');
    return { allowed: true, reason: null, mentioned, repliedToBot };
  }

  recordSent(groupId) {
    const key = String(groupId);
    const now = Date.now();
    this.lastSent.set(key, now);
    this.sent.set(key, [...(this.sent.get(key) || []).filter((time) => now - time < 3600000), now]);
  }

  #text(event) {
    if (typeof event.raw_message === 'string') return event.raw_message;
    return (event.message || []).filter((part) => part?.type === 'text').map((part) => part.data?.text || '').join('');
  }

  deny(reason) { return { allowed: false, reason }; }
}
