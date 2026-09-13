import { LLMClient } from './llm-client.js';
import { Retriever } from './retriever.js';

const DEFAULT_DISCLOSURE = '这是纪念账号生成的回复，不代表本人。';
const SENSITIVE_PATTERNS = [
  /(?:自杀|自残|割腕|轻生|杀人|爆炸|制毒|毒品交易|枪支交易)/u,
  /(?:未成年.{0,8}(?:性|裸|色情)|(?:性侵|强奸))/u,
  /(?:银行卡|身份证|密码|验证码|住址|家庭地址)/u
];
const PRIVATE_DATA_PATTERNS = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/u,
  /(?<!\d)\d{17}[\dXx](?![\dA-Za-z])/u,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu
];

function normalise(value) {
  return String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function messageText(message) {
  return String(message?.content ?? message?.text ?? message ?? '').trim();
}

function formatExamples(examples) {
  return examples.length
    ? examples.map((item, index) => `${index + 1}. ${item.content}`).join('\n')
    : '无可用样本；保持自然、简短的普通群聊回复。';
}

function resolveDisclosure(option) {
  if (option === false) return { enabled: false, text: DEFAULT_DISCLOSURE };
  if (typeof option === 'string') return { enabled: true, text: option };
  if (option && typeof option === 'object') {
    return { enabled: option.enabled !== false, text: option.text || DEFAULT_DISCLOSURE };
  }
  return { enabled: true, text: DEFAULT_DISCLOSURE };
}

export class ReplyEngine {
  constructor(config = {}, dependencies = {}) {
    const llmConfig = config.llm || config;
    this.llm = dependencies.llmClient || config.llmClient || new LLMClient(llmConfig, {
      fetch: dependencies.fetch ?? config.fetch
    });
    this.retriever = dependencies.retriever || config.retriever || new Retriever(config.samples || []);
    this.maxLength = config.maxReplyLength ?? 120;
    this.identityDisclosure = resolveDisclosure(config.identityDisclosure ?? config.disclosure);
  }

  buildMessages({ userMessage, context = [], profile = {}, examples = [], targetQQ, targetName, disclosure }) {
    const identity = targetName || targetQQ || '被纪念者';
    const disclosureRule = disclosure.enabled
      ? `每条候选开头必须原样包含“${disclosure.text}”。`
      : '不必在每条消息中附加身份披露，但绝不可声称自己是被纪念者本人。';
    const system = [
      '你为纪念账号提供群聊回复草案。账号不是被纪念者本人，不能假称本人、不能代表本人作出承诺、不能伪造记忆或经历。',
      `被纪念者标识：${identity}。只借鉴语言风格，不复制原话或私密信息。`,
      '不得输出敏感、违法伤害、色情或个人隐私信息。',
      disclosureRule,
      '仅返回 JSON：{"candidates":["候选1","候选2","候选3"]}。生成恰好 3 条彼此不同、简短的候选。'
    ].join('\n');
    const contextText = context.slice(-12).map((item) => messageText(item)).filter(Boolean).join('\n');
    const style = JSON.stringify({
      tone: profile.tone,
      catchphrases: profile.catchphrases,
      sentence_pattern: profile.sentence_pattern,
      emoji_style: profile.emoji_style
    });

    return [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `风格档案：${style}\n相关样本：\n${formatExamples(examples)}\n对话上下文：\n${contextText || '无'}\n对方最新消息：${userMessage}`
      }
    ];
  }

  validateCandidate(candidate, { targetQQ, targetName, existingTexts = [] } = {}) {
    const text = String(candidate || '').trim();
    const reasons = [];
    if (!text) reasons.push('empty');
    if (text.length > this.maxLength) reasons.push('too_long');
    if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(text))) reasons.push('sensitive_content');
    if (PRIVATE_DATA_PATTERNS.some((pattern) => pattern.test(text))) reasons.push('privacy');

    const identities = [targetName, targetQQ].filter(Boolean).map((value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const identityClaim = /(?:我是本人|本人(?:就是|回复|说)|作为本人)/u;
    if (identityClaim.test(text) || identities.some((identity) => new RegExp(`(?:我是|我就是|本人是)\\s*${identity}`, 'u').test(text))) {
      reasons.push('identity_impersonation');
    }
    const normalized = normalise(text);
    if (normalized && existingTexts.some((item) => normalise(item) === normalized)) reasons.push('duplicate');
    return { candidate: text, accepted: reasons.length === 0, reasons };
  }

  async generate(input, context, userMessage, options = {}) {
    const request = typeof input === 'object' && !Array.isArray(input)
      ? input
      : { targetQQ: input, context: context || [], userMessage, ...options };
    const {
      userMessage: message,
      context: conversation = [],
      profile = {},
      groupId,
      targetQQ,
      targetName,
      dryRun = false,
      identityDisclosure,
      maxLength
    } = request;
    if (!String(message || '').trim()) throw new TypeError('userMessage is required');

    const disclosure = resolveDisclosure(identityDisclosure ?? this.identityDisclosure);
    const examples = this.retriever.retrieve(message, { groupId, limit: 5 });
    const messages = this.buildMessages({
      userMessage: message,
      context: conversation,
      profile,
      examples,
      targetQQ,
      targetName,
      disclosure
    });
    const existingTexts = [...conversation.map(messageText), ...examples.map((item) => item.content)];
    const previousMaxLength = this.maxLength;
    if (maxLength !== undefined) this.maxLength = maxLength;

    try {
      if (dryRun) {
        return {
          dryRun: true,
          candidates: [],
          acceptedCandidates: [],
          rejected: [],
          rejectionReasons: [],
          retrievedExamples: examples,
          messages,
          disclosure
        };
      }

      const response = await this.llm.completeJSON({ messages, temperature: 0.75, maxTokens: 350 });
      const rawCandidates = Array.isArray(response.data?.candidates) ? response.data.candidates.slice(0, 3) : [];
      const validated = [];
      const candidateTexts = [...existingTexts];
      for (const candidate of rawCandidates) {
        const validation = this.validateCandidate(candidate, {
          targetQQ,
          targetName,
          existingTexts: candidateTexts
        });
        validated.push(validation);
        if (validation.accepted) candidateTexts.push(validation.candidate);
      }
      const rejected = validated.filter((item) => !item.accepted);
      return {
        dryRun: false,
        candidates: validated.map((item) => item.candidate),
        acceptedCandidates: validated.filter((item) => item.accepted).map((item) => item.candidate),
        rejected,
        rejectionReasons: [...new Set(rejected.flatMap((item) => item.reasons))],
        retrievedExamples: examples,
        disclosure,
        usage: response.usage
      };
    } finally {
      this.maxLength = previousMaxLength;
    }
  }

  generateReply(...args) {
    return this.generate(...args);
  }
}
