import WebSocket from 'ws';

export class SnowLumaClient {
  constructor(config = {}) {
    this.wsUrl = config.wsUrl;
    this.accessToken = config.accessToken || '';
    this.timeoutMs = config.timeoutMs || 30000;
    this.maxMessageBytes = config.maxMessageBytes || 2 * 1024 * 1024;
    this.reconnect = config.reconnect === true;
    this.reconnectBaseMs = config.reconnectBaseMs || 1000;
    this.reconnectMaxMs = config.reconnectMaxMs || 30000;
    this.ws = null;
    this.pending = new Map();
    this.handlers = new Set();
    this.idCounter = 0;
    this.closedByUser = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  connect() {
    if (!this.wsUrl) return Promise.reject(new Error('SnowLuma wsUrl 未配置'));
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve();
    }
    this.closedByUser = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const wsOptions = this.accessToken
        ? { headers: { Authorization: `Bearer ${this.accessToken}`, 'X-Access-Token': this.accessToken } }
        : undefined;
      const ws = new WebSocket(this.wsUrl, wsOptions);
      this.ws = ws;
      const onOpen = () => {
        settled = true;
        this.reconnectAttempt = 0;
        console.log('[SnowLuma] 已连接');
        resolve();
      };
      const onError = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      ws.once('open', onOpen);
      ws.on('error', onError);
      ws.on('message', (data) => this.#handleMessage(data));
      ws.on('close', () => {
        if (this.ws === ws) this.ws = null;
        this.#rejectPending(new Error('SnowLuma 连接已关闭'));
        console.log('[SnowLuma] 连接关闭');
        if (!this.closedByUser && this.reconnect) this.#scheduleReconnect();
      });
    });
  }

  onEvent(handler) {
    if (typeof handler !== 'function') throw new TypeError('event handler must be a function');
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async callAction(action, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('SnowLuma 未连接');
    const echo = String(++this.idCounter);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`请求超时: ${action}`));
      }, this.timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error);
      }
    });
  }

  async sendGroupMessage(groupId, message) {
    const segments = Array.isArray(message) ? message : [{ type: 'text', data: { text: String(message) } }];
    return this.callAction('send_group_msg', { group_id: String(groupId), message: segments });
  }

  async getLoginInfo() {
    return this.callAction('get_login_info');
  }

  async getGroupHistory(groupId, count = 100) {
    const messages = [];
    const seen = new Set();
    let cursor = null;
    while (messages.length < count) {
      const params = { group_id: String(groupId), count: Math.min(50, count - messages.length) };
      if (cursor) params.message_id = cursor;
      const data = await this.callAction('get_group_msg_history', params);
      const page = Array.isArray(data?.messages) ? data.messages : [];
      if (!page.length) break;
      const fresh = page.filter((item) => {
        const id = String(item.message_id ?? `${item.time}:${item.user_id ?? item.sender?.user_id}:${JSON.stringify(item.message ?? '')}`);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      messages.unshift(...fresh);
      const nextCursor = page[0]?.message_id;
      if (!nextCursor || String(nextCursor) === String(cursor) || fresh.length === 0) break;
      cursor = nextCursor;
    }
    return messages.slice(-count);
  }

  async getGroupMembers(groupId) {
    return this.callAction('get_group_member_list', { group_id: String(groupId) });
  }

  disconnect() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.#rejectPending(new Error('SnowLuma 客户端已断开'));
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  #handleMessage(data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    if (buffer.byteLength > this.maxMessageBytes) return;
    let msg;
    try { msg = JSON.parse(buffer.toString('utf8')); } catch { return; }
    if (msg && msg.echo !== undefined && this.pending.has(String(msg.echo))) {
      const key = String(msg.echo);
      const item = this.pending.get(key);
      this.pending.delete(key);
      clearTimeout(item.timer);
      if (msg.status === 'ok' || msg.retcode === 0 || msg.status === undefined) item.resolve(msg.data);
      else item.reject(new Error(msg.message || msg.wording || '请求失败'));
      return;
    }
    for (const handler of this.handlers) {
      Promise.resolve(handler(msg)).catch((error) => console.error('[SnowLuma] 事件处理失败:', error.message));
    }
  }

  #rejectPending(error) {
    for (const [key, item] of this.pending) {
      clearTimeout(item.timer);
      item.reject(error);
      this.pending.delete(key);
    }
  }

  #scheduleReconnect() {
    if (this.reconnectTimer || this.closedByUser) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => this.#scheduleReconnect());
    }, delay);
  }
}
