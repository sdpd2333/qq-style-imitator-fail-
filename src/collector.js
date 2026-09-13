import fs from 'fs/promises';
import path from 'path';
import { SnowLumaClient } from './snowluma-client.js';
import { normalizeOneBotMessage } from './message-normalizer.js';

export class Collector {
  constructor(config = {}) {
    this.config = config;
    this.client = new SnowLumaClient(config.snowluma || {});
  }

  async init() {
    await this.client.connect();
  }

  async collectGroupMessages(groupId, targetQQ, count) {
    console.log(`[采集] 正在获取群 ${groupId} 的聊天记录...`);
    const rawMessages = await this.client.getGroupHistory(groupId, count);
    const parsed = this.parseMessages(rawMessages);
    const targetMessages = parsed.filter((message) => message.qq === String(targetQQ));
    console.log(`[采集] 获取到 ${parsed.length} 条可用消息，目标用户 ${targetQQ} 有 ${targetMessages.length} 条`);
    return {
      groupId: String(groupId),
      targetQQ: String(targetQQ),
      allMessages: parsed,
      targetMessages,
      collectedAt: new Date().toISOString()
    };
  }

  parseMessages(rawMessages) {
    const seen = new Set();
    return rawMessages.map((message) => normalizeOneBotMessage(message))
      .filter((message) => message && message.id && !seen.has(message.id) && seen.add(message.id));
  }

  async saveRawData(data, filename) {
    if (this.config.collection?.saveRaw !== true) {
      throw new Error('原始消息保存默认关闭；请显式设置 collection.saveRaw=true 后再执行');
    }
    const dir = path.resolve(process.cwd(), 'data', 'raw');
    await fs.mkdir(dir, { recursive: true });
    const safeName = filename || `${data.groupId}_${data.targetQQ}_${Date.now()}.json`;
    if (!/^[A-Za-z0-9_-]+\.json$/u.test(safeName)) throw new Error('无效的数据文件名');
    const filepath = path.join(dir, safeName);
    const minimal = {
      groupId: data.groupId,
      targetQQ: data.targetQQ,
      targetMessages: data.targetMessages,
      collectedAt: data.collectedAt
    };
    await fs.writeFile(filepath, `${JSON.stringify(minimal, null, 2)}\n`, { mode: 0o600 });
    console.log(`[保存] 最小化采集数据已保存到: ${filepath}`);
    return filepath;
  }

  disconnect() {
    this.client.disconnect();
  }
}
