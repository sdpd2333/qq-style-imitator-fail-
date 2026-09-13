import { ProfileManager } from './profile.js';

export class Imitator {
  constructor(config) {
    this.config = config;
    this.profileManager = new ProfileManager();
  }

  async generateReply(targetQQ, context, userMessage) {
    const profile = await this.profileManager.load(targetQQ);
    if (!profile) {
      throw new Error(`用户 ${targetQQ} 的风格档案不存在，请先运行 analyze`);
    }

    const profilePrompt = this.profileManager.buildPrompt(profile);

    const contextText = context.slice(-20).map(m =>
      `[${m.nickname}]: ${m.content}`
    ).join('\n');

    const prompt = `你现在需要模仿QQ用户说话风格进行回复。

${profilePrompt}

## 当前对话上下文
${contextText}

## 对方说
${userMessage}

## 要求
1. 严格使用该用户的说话风格
2. 保持回复自然，符合群聊语境
3. 适当使用该用户的常用表情和口头禅
4. 回复长度和语气要符合该用户习惯

请直接生成一条回复，不要加任何说明:`;

    return {
      prompt,
      profile: profile.tone,
      styleHint: profile.catchphrases?.[0]
    };
  }

  async explainStyle(targetQQ) {
    const profile = await this.profileManager.load(targetQQ);
    if (!profile) {
      return `用户 ${targetQQ} 的风格档案不存在`;
    }

    return `
## ${targetQQ} 的说话风格分析

**语气**: ${profile.tone || '自然'}
**句式**: ${profile.sentence_pattern || '正常'}
**口头禅**: ${profile.catchphrases?.join('、') || '无'}
**表情**: ${profile.emoji_style || '无特殊习惯'}

**整体印象**:
${profile.personality_summary || '暂无总结'}
`.trim();
  }
}
