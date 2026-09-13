import fs from 'fs/promises';
import path from 'path';

const PROFILES_DIR = path.join('data', 'profiles');

export class ProfileManager {
  constructor() {
    this.cache = new Map();
  }

  async load(targetQQ) {
    if (this.cache.has(targetQQ)) {
      return this.cache.get(targetQQ);
    }

    const filepath = path.join(PROFILES_DIR, `${targetQQ}.json`);
    try {
      const data = await fs.readFile(filepath, 'utf-8');
      const profile = JSON.parse(data);
      this.cache.set(targetQQ, profile);
      return profile;
    } catch (e) {
      return null;
    }
  }

  async save(targetQQ, profile) {
    await fs.mkdir(PROFILES_DIR, { recursive: true });

    profile.targetQQ = targetQQ;
    profile.updatedAt = new Date().toISOString();

    const filepath = path.join(PROFILES_DIR, `${targetQQ}.json`);
    await fs.writeFile(filepath, JSON.stringify(profile, null, 2));
    this.cache.set(targetQQ, profile);

    console.log(`[Profile] 已保存用户 ${targetQQ} 的风格档案`);
    return filepath;
  }

  async list() {
    try {
      const files = await fs.readdir(PROFILES_DIR);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    } catch {
      return [];
    }
  }

  buildPrompt(profile) {
    return `
## 用户风格特征

### 基本信息
- QQ号: ${profile.targetQQ}
- 最后更新: ${profile.updatedAt}

### 说话特点
- 口头禅: ${profile.catchphrases?.join('、') || '无'}
- 语气风格: ${profile.tone || '自然'}
- 句式特点: ${profile.sentence_pattern || '正常'}

### 表情习惯
${profile.emoji_style || '无特殊表情习惯'}

### 高频用词
${profile.topWords?.slice(0, 8).map(w => `- ${w.word} (${w.count}次)`).join('\n') || '暂无'}

### 整体风格
${profile.personality_summary || '暂无总结'}
`.trim();
  }
}
