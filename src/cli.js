import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Collector } from './collector.js';
import { Analyzer } from './analyzer.js';
import { ProfileManager } from './profile.js';
import { ReplyEngine } from './reply-engine.js';
import { GovernanceService } from './governance.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PROJECT_ROOT);
const program = new Command();

function resolveProjectPath(filePath) {
  return path.resolve(PROJECT_ROOT, filePath);
}

async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(resolveProjectPath('config/config.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('配置文件不存在，请先复制 config/config.example.json 为 config/config.json');
    throw new Error(`无法读取配置文件: ${error.message}`);
  }
}

async function loadProfile(user) {
  const profile = await new ProfileManager().load(user);
  if (!profile) throw new Error(`用户 ${user} 的风格档案不存在，请先运行 analyze`);
  return profile;
}

async function selectDataFile(user, explicitFile) {
  if (explicitFile) {
    const filePath = resolveProjectPath(explicitFile);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw new Error(`聊天记录文件不存在或不是普通文件: ${filePath}`);
    return { path: filePath, data: JSON.parse(await fs.readFile(filePath, 'utf8')) };
  }
  const rawDir = resolveProjectPath('data/raw');
  const entries = await fs.readdir(rawDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(rawDir, entry.name);
    try {
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (String(data.targetQQ) !== String(user) || !Array.isArray(data.targetMessages)) continue;
      const stat = await fs.stat(filePath);
      candidates.push({ path: filePath, data, timestamp: Date.parse(data.collectedAt) || stat.mtimeMs });
    } catch {
      // Ignore unrelated or malformed files while selecting a matching record.
    }
  }
  candidates.sort((a, b) => b.timestamp - a.timestamp);
  if (!candidates.length) throw new Error(`未找到用户 ${user} 的聊天记录；原始保存默认关闭，请使用 --file 指定已获授权的最小化数据文件`);
  return candidates[0];
}

async function governanceFor(config) {
  const dataDir = config.memorial?.dataDir ? resolveProjectPath(config.memorial.dataDir) : undefined;
  return new GovernanceService({ dataDir }).initialize();
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

program.name('qq-style-imitator').description('经授权的纪念账号风格草案与治理工具');

program.command('collect').description('采集指定用户的聊天记录；原始保存需显式启用')
  .requiredOption('-g, --group <groupId>', 'QQ群号').requiredOption('-u, --user <qq>', '目标用户QQ号')
  .option('-c, --count <number>', '采集消息数量', '200').action(async (options) => {
    const config = await loadConfig();
    const collector = new Collector(config);
    try {
      await collector.init();
      const data = await collector.collectGroupMessages(options.group, options.user, Number.parseInt(options.count, 10));
      if (config.collection?.saveRaw === true) await collector.saveRawData(data);
      else console.log('原始消息未保存（默认关闭）。仅在取得适当授权后启用 collection.saveRaw。');
      console.log(`采集完成：用户 ${options.user} 有 ${data.targetMessages.length} 条消息。`);
    } finally { collector.disconnect(); }
  });

program.command('analyze').description('从授权的最小化聊天记录分析风格并生成 Profile')
  .requiredOption('-u, --user <qq>', '目标用户QQ号').option('-f, --file <path>', '聊天记录文件；相对路径以项目根目录解析')
  .action(async (options) => {
    const config = await loadConfig();
    const source = await selectDataFile(options.user, options.file);
    const messages = source.data.targetMessages;
    if (!Array.isArray(messages)) throw new Error(`聊天记录缺少 targetMessages 数组: ${source.path}`);
    if (messages.length < (config.analysis?.minMessages || 50)) console.warn(`警告：消息数量较少（${messages.length} 条），分析结果可能不准确。`);
    const stats = await new Analyzer(config).analyze(messages);
    const profile = { stats, catchphrases: stats.topWords.slice(0, 5).map((word) => word.word), topWords: stats.topWords,
      emoji_style: stats.emojiHabits.slice(0, 5).map((emoji) => emoji.emoji).join(' '),
      sentence_pattern: `短句${stats.sentenceStyle.short}条，中句${stats.sentenceStyle.medium}条，长句${stats.sentenceStyle.long}条`, tone: '自然' };
    await new ProfileManager().save(options.user, profile);
    console.log(`分析完成，已使用: ${source.path}`);
  });

program.command('test').description('以 ReplyEngine dry-run 预览草案请求；绝不调用模型或发送消息')
  .requiredOption('-u, --user <qq>', '目标用户QQ号').requiredOption('-m, --message <text>', '测试消息')
  .option('-g, --group <groupId>', '群号，用于匹配已授权样本').action(async (options) => {
    const config = await loadConfig();
    const result = await new ReplyEngine(config).generate({ targetQQ: options.user, groupId: options.group,
      userMessage: options.message, profile: await loadProfile(options.user), dryRun: true });
    console.log('ReplyEngine dry-run（未调用模型，未发送消息）：');
    console.log(`身份披露：${result.disclosure.enabled ? result.disclosure.text : '未启用'}`);
    console.log(`检索样本数：${result.retrievedExamples.length}`);
    printJson(result.messages);
  });

program.command('imitate').description('生成纪念账号回复草案；该命令从不发送消息')
  .requiredOption('-u, --user <qq>', '目标用户QQ号').requiredOption('-m, --message <text>', '待回复消息')
  .option('-g, --group <groupId>', '群号，用于匹配已授权样本').option('--dry-run', '仅预览 ReplyEngine 请求，不调用模型')
  .action(async (options) => {
    const config = await loadConfig();
    const result = await new ReplyEngine(config).generate({ targetQQ: options.user, groupId: options.group,
      userMessage: options.message, profile: await loadProfile(options.user), dryRun: options.dryRun === true });
    if (result.dryRun) { console.log('ReplyEngine dry-run（未调用模型，未发送消息）：'); printJson(result.messages); return; }
    console.log('纪念账号回复草案（未发送）：');
    result.acceptedCandidates.forEach((candidate, index) => console.log(`${index + 1}. ${candidate}`));
    if (!result.acceptedCandidates.length) console.log('没有通过安全校验的候选。');
    if (result.rejectionReasons.length) console.log(`拒绝原因：${result.rejectionReasons.join(', ')}`);
  });

program.command('list').description('列出所有已保存的 Profile').action(async () => {
  const profiles = await new ProfileManager().list();
  if (!profiles.length) console.log('暂无 Profile'); else profiles.forEach((profile) => console.log(`- ${profile}`));
});

program.command('show').description('查看指定用户的风格分析').requiredOption('-u, --user <qq>', '目标用户QQ号')
  .action(async (options) => console.log(new ProfileManager().buildPrompt(await loadProfile(options.user))));

const memorial = program.command('memorial').description('管理纪念账号的创建、授权、暂停、删除和审计');
memorial.command('create').description('创建待授权纪念账号；runtime 和主动参与默认关闭')
  .requiredOption('--id <memorialId>', '纪念账号 ID').option('--name <name>', '显示名称').option('--subject-qq <qq>', '被纪念者 QQ 号')
  .option('--group <groupIds...>', '允许参与的群号列表').option('--disclosure <text>', '回复中使用的身份披露文本').option('--actor <actor>', '操作者标识')
  .action(async (options) => {
    const created = await (async () => { const service = await governanceFor(await loadConfig()); return service.createMemorial({
      id: options.id, name: options.name, subject: options.subjectQq ? { qq: options.subjectQq } : {}, scope: { groupIds: options.group || [] },
      identityDisclosure: options.disclosure ? { enabled: true, text: options.disclosure } : { enabled: false }, runtime: { enabled: false }, participation: { enabled: false }
    }, { actor: options.actor }); })();
    printJson(created);
  });
memorial.command('authorize').description('标记为已授权；不会自动启用 runtime 或主动参与').requiredOption('--id <memorialId>', '纪念账号 ID')
  .option('--actor <actor>', '操作者标识').option('--reason <reason>', '授权说明').action(async (options) => {
    const service = await governanceFor(await loadConfig()); printJson(await service.authorize({ memorialId: options.id, actor: options.actor, reason: options.reason }));
  });
memorial.command('pause').description('暂停账号并关闭 runtime 与主动参与').requiredOption('--id <memorialId>', '纪念账号 ID')
  .option('--actor <actor>', '操作者标识').option('--reason <reason>', '暂停说明').action(async (options) => {
    const service = await governanceFor(await loadConfig()); printJson(await service.suspend({ memorialId: options.id, actor: options.actor, reason: options.reason }));
  });
memorial.command('enable').description('启用已授权纪念账号的 runtime 与参与开关；需要显式确认')
  .requiredOption('--id <memorialId>', '纪念账号 ID').requiredOption('--confirm', '确认已核验授权、群范围和纪念身份披露')
  .option('--actor <actor>', '操作者标识').action(async (options) => {
    const service = await governanceFor(await loadConfig());
    const current = await service.getMemorial(options.id);
    if (!current) throw new Error(`纪念账号不存在或已删除: ${options.id}`);
    if (current.status !== 'approved') throw new Error('纪念账号尚未获得授权；请先运行 memorial authorize');
    if (!current.scope?.groupIds?.length) throw new Error('纪念账号没有允许参与的群范围');
    if (!current.identityDisclosure?.enabled || !current.identityDisclosure.text) {
      throw new Error('首次启用要求配置身份披露文本；请重新创建纪念档案并传入 --disclosure');
    }
    const enabled = await service.store.updateMemorial(current.id, {
      runtime: { enabled: true }, participation: { enabled: true }
    });
    await service.audit.append({ action: 'memorial.enabled', memorialId: enabled.id, actor: options.actor, details: { groupIds: enabled.scope.groupIds } });
    printJson(enabled);
  });
memorial.command('delete').description('删除账号及关联样本；默认软删除').requiredOption('--id <memorialId>', '纪念账号 ID')
  .option('--hard', '永久移除账号记录').option('--actor <actor>', '操作者标识').option('--reason <reason>', '删除说明').action(async (options) => {
    const service = await governanceFor(await loadConfig()); const result = await service.cascadeDelete(options.id, { actor: options.actor, reason: options.reason, hardDelete: options.hard === true });
    if (!result) throw new Error(`纪念账号不存在: ${options.id}`); printJson(result);
  });
memorial.command('audit').description('查看纪念账号治理审计记录').option('--id <memorialId>', '按纪念账号 ID 筛选')
  .option('--limit <number>', '最多返回记录数', '100').action(async (options) => {
    const service = await governanceFor(await loadConfig()); const limit = Number.parseInt(options.limit, 10);
    if (!Number.isInteger(limit)) throw new Error('--limit 必须是整数'); printJson(await service.audit.list({ memorialId: options.id, limit }));
  });

program.command('run').description('启动受治理的实时纪念账号运行时；不会绕过授权和开关')
  .requiredOption('--id <memorialId>', '纪念账号 ID')
  .option('--mode <mode>', '参与模式：mention_only/reply_to_bot/review_required/conservative_auto', 'mention_only')
  .action(async (options) => {
    const config = await loadConfig();
    const governance = await governanceFor(config);
    const memorial = await governance.getMemorial(options.id);
    if (!memorial) throw new Error(`纪念账号不存在或已删除: ${options.id}`);
    const client = new (await import('./snowluma-client.js')).SnowLumaClient(config.snowluma || {});
    const profileManager = new ProfileManager();
    const policy = new (await import('./participation-policy.js')).ParticipationPolicy({
      ...(config.runtime || {}), mode: options.mode, selfId: config.snowluma?.selfId
    });
    const engine = new ReplyEngine({
      llm: config.llm,
      identityDisclosure: memorial.identityDisclosure,
      samples: await governance.store.listSamples(memorial.id)
    });
    const runtime = new (await import('./runtime.js')).MemorialRuntime({
      client, governance, replyEngine: engine,
      profileLoader: async () => profileManager.load(memorial.subject?.qq || memorial.subjectQQ || ''),
      memorialResolver: (event) => memorial.scope?.groupIds?.includes(String(event.group_id)) ? memorial.id : null,
      policy, audit: governance.audit
    });
    await runtime.start();
    console.log(`纪念账号运行中：${memorial.name}；模式=${options.mode}。按 Ctrl+C 停止。`);
    await new Promise((resolve) => {
      const stop = () => { runtime.stop(); resolve(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  });

program.parseAsync().catch((error) => { console.error(`错误: ${error.message}`); process.exitCode = 1; });
