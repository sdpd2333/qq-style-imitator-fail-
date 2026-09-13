const SENSITIVE_PATTERNS = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/gu,
  /(?<!\d)\d{17}[\dXx](?![\dA-Za-z])/gu,
  /(?:银行卡|身份证|密码|验证码|住址|家庭地址)\s*[:：]?\s*\S+/gu
];

function textOf(segment) {
  if (!segment || typeof segment !== 'object') return '';
  if (segment.type === 'text') return String(segment.data?.text || '');
  if (segment.type === 'face') return `[表情:${segment.data?.text || segment.data?.id || '未知'}]`;
  if (segment.type === 'at') return `[提及:${segment.data?.qq || '成员'}]`;
  if (segment.type === 'reply') return '[回复消息]';
  if (segment.type === 'image') return '[图片]';
  if (segment.type === 'record') return '[语音]';
  if (segment.type === 'video') return '[视频]';
  if (segment.type === 'file') return '[文件]';
  return `[${segment.type || '未知消息'}]`;
}

export function redactSensitiveText(value) {
  return SENSITIVE_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[已脱敏]'), String(value || ''));
}

export function normalizeOneBotMessage(raw, { includeNonTextSummary = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const segments = Array.isArray(raw.message) ? raw.message : [];
  const plainText = segments.filter((segment) => segment?.type === 'text')
    .map((segment) => String(segment.data?.text || '')).join('');
  const displayText = segments.map((segment) => includeNonTextSummary ? textOf(segment) : (segment?.type === 'text' ? textOf(segment) : ''))
    .join('');
  const content = redactSensitiveText(plainText || displayText).trim();
  if (!content) return null;
  const sender = raw.sender || {};
  return {
    id: String(raw.message_id ?? raw.message_seq ?? ''),
    groupId: raw.group_id === undefined ? null : String(raw.group_id),
    qq: String(sender.user_id ?? raw.user_id ?? ''),
    nickname: String(sender.card || sender.nickname || ''),
    content,
    plainText: redactSensitiveText(plainText).trim(),
    segmentTypes: [...new Set(segments.map((segment) => segment?.type).filter(Boolean))],
    replyTo: segments.find((segment) => segment?.type === 'reply')?.data?.id || null,
    mentionedQQs: segments.filter((segment) => segment?.type === 'at').map((segment) => String(segment.data?.qq || '')).filter(Boolean),
    time: raw.time ? new Date(raw.time * 1000).toISOString() : new Date().toISOString()
  };
}

export function isGroupMessage(event) {
  return event?.post_type === 'message' && event?.message_type === 'group' && event?.group_id !== undefined;
}
