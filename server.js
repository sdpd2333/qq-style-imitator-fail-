import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3080;
const HOST = '127.0.0.1';
const JSON_BODY_LIMIT = '100kb';
const PROMPT_CONTENT_LIMIT = 100 * 1024;

app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG_PATH = path.join(__dirname, 'config', 'config.json');
const PROFILES_DIR = path.join(__dirname, 'data', 'profiles');
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const ALLOWED_PROMPTS = new Set(['style-analysis.md', 'imitation.md', 'safety-review.md']);
const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const DEFAULT_CONFIG = {
  snowluma: { wsUrl: 'ws://127.0.0.1:3001/', accessToken: '', selfId: '' },
  llm: { provider: 'openai', apiKey: '', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
  collection: { messageCount: 200, saveRaw: false },
  analysis: { minMessages: 50, contextWindowSize: 20 },
  memorial: {
    id: '', name: '', subjectQQ: '', groupIds: [], identityDisclosure: '', authorizationStatus: 'pending',
    runtimeEnabled: false, participationEnabled: false, participationMode: 'mention_only'
  },
  runtime: { enabled: false, participationMode: 'mention_only', minIntervalMs: 60000, maxPerHour: 8, maxConsecutive: 2 },
  governance: { dataRetentionDays: 30, allowRawStorage: false }
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validProfileId(value) {
  return typeof value === 'string' && PROFILE_ID_PATTERN.test(value);
}

function profilePath(qq) {
  if (!validProfileId(qq)) return null;
  const filepath = path.resolve(PROFILES_DIR, `${qq}.json`);
  return filepath.startsWith(`${path.resolve(PROFILES_DIR)}${path.sep}`) ? filepath : null;
}

function pickConfig(body, current) {
  if (!isPlainObject(body)) throw new Error('Configuration body must be a JSON object');

  const result = structuredClone(DEFAULT_CONFIG);
  const sections = {
    snowluma: ['wsUrl', 'accessToken', 'selfId'],
    llm: ['provider', 'apiKey', 'model', 'baseUrl'],
    collection: ['messageCount', 'saveRaw'],
    analysis: ['minMessages', 'contextWindowSize'],
    memorial: ['id', 'name', 'subjectQQ', 'groupIds', 'identityDisclosure', 'authorizationStatus', 'runtimeEnabled', 'participationEnabled', 'participationMode'],
    runtime: ['enabled', 'participationMode', 'minIntervalMs', 'maxPerHour', 'maxConsecutive'],
    governance: ['dataRetentionDays', 'allowRawStorage']
  };

  for (const key of Object.keys(body)) {
    if (!Object.hasOwn(sections, key)) throw new Error(`Configuration field "${key}" is not allowed`);
  }

  for (const [section, fields] of Object.entries(sections)) {
    if (body[section] !== undefined && !isPlainObject(body[section])) {
      throw new Error(`Configuration field "${section}" must be an object`);
    }
    const source = body[section] || {};
    const existing = isPlainObject(current?.[section]) ? current[section] : {};
    for (const key of Object.keys(source)) {
      if (!fields.includes(key)) throw new Error(`Configuration field "${section}.${key}" is not allowed`);
    }
    for (const field of fields) {
      const isSecret = (section === 'snowluma' && field === 'accessToken') || (section === 'llm' && field === 'apiKey');
      if (source[field] !== undefined && (!isSecret || source[field] !== '')) result[section][field] = source[field];
      else if (existing[field] !== undefined) result[section][field] = existing[field];
    }
  }

  for (const [section, fields] of Object.entries(sections)) {
    for (const field of fields) {
      const value = result[section][field];
      if (['saveRaw', 'runtimeEnabled', 'participationEnabled', 'enabled', 'allowRawStorage'].includes(field)) {
        if (typeof value !== 'boolean') throw new Error(`Configuration field "${section}.${field}" must be a boolean`);
      } else if (field === 'groupIds') {
        if (!Array.isArray(value) || value.length > 1000 || value.some((groupId) => typeof groupId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(groupId))) {
          throw new Error('Configuration field "memorial.groupIds" must be an array of safe group identifiers');
        }
      } else if (['messageCount', 'minMessages', 'contextWindowSize', 'minIntervalMs', 'maxPerHour', 'maxConsecutive', 'dataRetentionDays'].includes(field)) {
        if (!Number.isInteger(value) || value < 0 || value > 100000) {
          throw new Error(`Configuration field "${section}.${field}" must be an integer between 0 and 100000`);
        }
      } else if (typeof value !== 'string' || value.length > 4096) {
        throw new Error(`Configuration field "${section}.${field}" must be a string no longer than 4096 characters`);
      }
    }
  }

  return result;
}

async function readConfig() {
  try {
    const data = await fs.readFile(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(data);
    if (!isPlainObject(config)) throw new Error('Configuration file must contain a JSON object');
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(DEFAULT_CONFIG);
    throw error;
  }
}

function publicConfig(config) {
  const sanitized = structuredClone(config);
  const apiKey = typeof sanitized.llm?.apiKey === 'string' ? sanitized.llm.apiKey : '';
  const accessToken = typeof sanitized.snowluma?.accessToken === 'string' ? sanitized.snowluma.accessToken : '';
  if (!isPlainObject(sanitized.llm)) sanitized.llm = {};
  if (!isPlainObject(sanitized.snowluma)) sanitized.snowluma = {};
  delete sanitized.llm.apiKey;
  delete sanitized.snowluma.accessToken;
  sanitized.llm.hasApiKey = Boolean(apiKey);
  sanitized.snowluma.hasAccessToken = Boolean(accessToken);
  return sanitized;
}

function sendServerError(res, error) {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/config', async (req, res) => {
  try {
    res.json(publicConfig(await readConfig()));
  } catch (error) {
    sendServerError(res, error);
  }
});

app.post('/api/config', async (req, res) => {
  try {
    const config = pickConfig(req.body, await readConfig());
    await fs.mkdir(path.join(__dirname, 'config'), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/profiles', async (req, res) => {
  try {
    await fs.mkdir(PROFILES_DIR, { recursive: true });
    const files = await fs.readdir(PROFILES_DIR);
    const profiles = [];
    for (const file of files.filter(file => file.endsWith('.json'))) {
      if (!validProfileId(path.basename(file, '.json'))) continue;
      const data = JSON.parse(await fs.readFile(path.join(PROFILES_DIR, file), 'utf-8'));
      profiles.push(data);
    }
    res.json(profiles);
  } catch (error) {
    sendServerError(res, error);
  }
});

app.get('/api/profiles/:qq', async (req, res) => {
  const filepath = profilePath(req.params.qq);
  if (!filepath) return res.status(400).json({ error: 'Invalid profile identifier' });
  try {
    const data = await fs.readFile(filepath, 'utf-8');
    res.json(JSON.parse(data));
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Profile not found' });
    sendServerError(res, error);
  }
});

app.post('/api/profiles/:qq', async (req, res) => {
  const filepath = profilePath(req.params.qq);
  if (!filepath) return res.status(400).json({ error: 'Invalid profile identifier' });
  if (!isPlainObject(req.body)) return res.status(400).json({ error: 'Profile body must be a JSON object' });
  try {
    await fs.mkdir(PROFILES_DIR, { recursive: true });
    const profile = { ...req.body, targetQQ: req.params.qq, updatedAt: new Date().toISOString() };
    await fs.writeFile(filepath, JSON.stringify(profile, null, 2), 'utf-8');
    res.json({ success: true });
  } catch (error) {
    sendServerError(res, error);
  }
});

app.delete('/api/profiles/:qq', async (req, res) => {
  const filepath = profilePath(req.params.qq);
  if (!filepath) return res.status(400).json({ error: 'Invalid profile identifier' });
  try {
    await fs.unlink(filepath);
    res.json({ success: true });
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Profile not found' });
    sendServerError(res, error);
  }
});

app.get('/api/prompts', async (req, res) => {
  try {
    const prompts = [];
    for (const file of ALLOWED_PROMPTS) {
      const content = await fs.readFile(path.join(PROMPTS_DIR, file), 'utf-8');
      prompts.push({ name: file, content });
    }
    res.json(prompts);
  } catch (error) {
    sendServerError(res, error);
  }
});

app.post('/api/prompts/:name', async (req, res) => {
  const filename = req.params.name.endsWith('.md') ? req.params.name : `${req.params.name}.md`;
  if (!ALLOWED_PROMPTS.has(filename)) return res.status(400).json({ error: 'Prompt is not allowed' });
  if (!isPlainObject(req.body) || typeof req.body.content !== 'string') {
    return res.status(400).json({ error: 'Prompt content must be a string' });
  }
  if (Buffer.byteLength(req.body.content, 'utf-8') > PROMPT_CONTENT_LIMIT) {
    return res.status(413).json({ error: 'Prompt content exceeds 100kb limit' });
  }
  try {
    await fs.writeFile(path.join(PROMPTS_DIR, filename), req.body.content, 'utf-8');
    res.json({ success: true });
  } catch (error) {
    sendServerError(res, error);
  }
});

app.post('/api/preview-prompt', async (req, res) => {
  if (!isPlainObject(req.body) || !isPlainObject(req.body.profile)) {
    return res.status(400).json({ error: 'Profile body must be a JSON object' });
  }

  const { profile, context, message } = req.body;
  const profileText = `
## 用户风格特征

- QQ号: ${profile.targetQQ}
- 语气: ${profile.tone || '自然'}
- 口头禅: ${profile.catchphrases?.join('、') || '无'}
- 表情习惯: ${profile.emoji_style || '无'}
- 句式特点: ${profile.sentence_pattern || '正常'}
- 整体风格: ${profile.personality_summary || '暂无'}
`.trim();

  const contextText = Array.isArray(context)
    ? context.map(item => `[${item?.nickname || ''}]: ${item?.content || ''}`).join('\n')
    : '';
  const prompt = `你现在需要模仿QQ用户说话风格进行回复。

${profileText}

## 当前对话上下文
${contextText || '(无上下文)'}

## 对方说
${typeof message === 'string' ? message : '(无消息)'}

## 要求
1. 严格使用该用户的说话风格
2. 保持回复自然，符合群聊语境
3. 适当使用该用户的常用表情和口头禅

请直接生成一条回复，不要加任何说明:`;

  res.json({ prompt });
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'JSON body exceeds 100kb limit' });
  }
  sendServerError(res, error);
});

app.listen(PORT, HOST, () => {
  console.log(`\nQQ Style Imitator Web UI`);
  console.log(`   http://${HOST}:${PORT}\n`);
});
