import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GovernanceService } from '../src/governance.js';
import { normalizeOneBotMessage } from '../src/message-normalizer.js';
import { ParticipationPolicy } from '../src/participation-policy.js';
import { ReplyEngine } from '../src/reply-engine.js';
import { Retriever } from '../src/retriever.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'qq-memorial-test-'));
}

test('未经授权、未启用或越群的纪念档案不能参与', async (t) => {
  const dataDir = await tempDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const governance = new GovernanceService({ dataDir });
  const memorial = await governance.createMemorial({
    id: 'memorial-one',
    name: '纪念账号',
    scope: { groupIds: ['group-1'] },
    identityDisclosure: true
  });
  assert.equal((await governance.canParticipate({ memorialId: memorial.id, groupId: 'group-1' })).allowed, false);
  await governance.authorize({ memorialId: memorial.id, actor: 'maintainer' });
  await governance.store.updateMemorial(memorial.id, { runtime: { enabled: true }, participation: { enabled: true } });
  assert.equal((await governance.canParticipate({ memorialId: memorial.id, groupId: 'group-2' })).reason, 'group_not_authorized');
  assert.equal((await governance.canParticipate({ memorialId: memorial.id, groupId: 'group-1' })).allowed, true);
});

test('删除纪念档案时删除关联样本', async (t) => {
  const dataDir = await tempDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const governance = new GovernanceService({ dataDir });
  const memorial = await governance.createMemorial({ id: 'memorial-delete', scope: { groupIds: ['1'] } });
  await governance.store.writeSample(memorial.id, 'sample-a', { content: '已经获得授权的样本' });
  const deleted = await governance.cascadeDelete(memorial.id, { actor: 'maintainer' });
  assert.equal(deleted.deletedSamples, 1);
  assert.equal(await governance.store.readSample(memorial.id, 'sample-a'), null);
});

test('消息规范化会保留段类型并脱敏电话', () => {
  const message = normalizeOneBotMessage({
    message_id: 10,
    group_id: 100,
    time: 1,
    sender: { user_id: 200, nickname: '成员' },
    message: [
      { type: 'text', data: { text: '请联系 13800138000' } },
      { type: 'face', data: { id: '14' } }
    ]
  });
  assert.equal(message.groupId, '100');
  assert.match(message.content, /\[已脱敏\]/u);
  assert.deepEqual(message.segmentTypes, ['text', 'face']);
});

test('参与策略对敏感话题和冷却时间保持静默', () => {
  const policy = new ParticipationPolicy({ mode: 'conservative_auto', selfId: '999', minIntervalMs: 60_000 });
  const memorial = { status: 'approved', runtime: { enabled: true }, participation: { enabled: true }, scope: { groupIds: ['123'] } };
  const base = { post_type: 'message', message_type: 'group', group_id: '123', sender: { user_id: '100' }, raw_message: '今天聊什么', message: [{ type: 'text', data: { text: '今天聊什么' } }] };
  assert.equal(policy.decide(base, { memorial }).allowed, true);
  assert.equal(policy.decide({ ...base, raw_message: '有人提到自杀', message: [{ type: 'text', data: { text: '有人提到自杀' } }] }, { memorial }).reason, 'sensitive_topic');
  policy.recordSent('123');
  assert.equal(policy.decide(base, { memorial }).reason, 'cooldown');
});

test('回复引擎 dry-run 不调用模型，候选安全过滤会拒绝冒充', async () => {
  let called = false;
  const engine = new ReplyEngine({
    identityDisclosure: true,
    samples: [{ id: 's1', groupId: '123', content: '今天也太离谱了吧' }]
  }, {
    llmClient: { completeJSON: async () => { called = true; return { data: { candidates: [] } }; } }
  });
  const preview = await engine.generate({ userMessage: '今天离谱', groupId: '123', dryRun: true });
  assert.equal(called, false);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.retrievedExamples[0].id, 's1');
  const result = engine.validateCandidate('我是本人，现在还在线', { targetName: '小明' });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes('identity_impersonation'));
});

test('检索器只返回匹配群中的去重样本', () => {
  const retriever = new Retriever([
    { id: '1', groupId: 'a', content: '今天这个项目真的离谱' },
    { id: '2', groupId: 'a', content: '今天这个项目真的离谱' },
    { id: '3', groupId: 'b', content: '今天这个项目真的离谱' }
  ]);
  const results = retriever.retrieve('这个项目离谱', { groupId: 'a' });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, '1');
});
