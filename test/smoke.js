'use strict';
/**
 * 冒烟测试：不依赖 DSH、不联网、不装任何包。
 *   node test/smoke.js
 * 覆盖三件事：
 *   1. memory-core 的记忆模型（去重合并 / 权重 / 遗忘 / 检索 / 关系图 / 统计）
 *   2. host 半侧的路由注册与 handler（用假 req/res 直接打）
 *   3. 首屏注入脚本（幂等、含标记与 client.js）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + name);
  } else {
    fail++;
    failures.push(name + (extra ? '  -> ' + extra : ''));
    console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : ''));
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}

function section(t) {
  console.log('\n' + t);
}

// ── 临时数据目录 ─────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dayu-smoke-'));
const dataDir = path.join(tmpRoot, 'memory');
fs.mkdirSync(dataDir, { recursive: true });

const core = require('../lib/memory-core.js');
core.configure({ dataDir: dataDir, ownerId: '10001' });

const OWNER = '10001';

// ─────────────────────────────────────────────────────────────
section('[1] 相似度引擎');
// ─────────────────────────────────────────────────────────────
{
  const a = core.similarity('主人喜欢喝咖啡', '主人喜欢喝咖啡');
  ok('完全相同的文本相似度为 1', a > 0.98, 'got ' + a);

  const b = core.similarity('火锅', '火锅了');
  ok('"火锅" 与 "火锅了" 能识别为同一件事（去虚词）', b >= core.MERGE_SIM, 'got ' + b.toFixed(3));

  const c = core.similarity('今天天气不错', '服务器硬盘坏了');
  ok('无关文本相似度很低', c < 0.3, 'got ' + c.toFixed(3));

  const nn = core.normalize('火锅了啊呢');
  eq('normalize 去掉虚词', nn, '火锅');
  ok('shingles 返回 3-gram 集合', core.shingles('一二三四五') instanceof Set && core.shingles('一二三四五').size === 3, 'size=' + core.shingles('一二三四五').size);
  ok('minhashSignature 长度等于种子数', core.minhashSignature('测试文本').length === 32, 'got ' + core.minhashSignature('测试文本').length);
  ok('jaccard 自反为 1', core.jaccard('abcabc', 'abcabc') === 1);
}

// ─────────────────────────────────────────────────────────────
section('[2] 分类与关键词');
// ─────────────────────────────────────────────────────────────
{
  eq('"不要提他的前任" → rule', core.classifyByKeyword('不要提他的前任'), 'rule');
  eq('"我最喜欢吃火锅" → preference', core.classifyByKeyword('我最喜欢吃火锅'), 'preference');
  eq('"明天要去面试" → goal', core.classifyByKeyword('明天要去面试'), 'goal');
  eq('"今天特别难过" → emotion', core.classifyByKeyword('今天特别难过'), 'emotion');
  eq('"他住在杭州" → fact', core.classifyByKeyword('他住在杭州'), 'fact');

  const kw = core.extractKeywords('主人喜欢在深夜写代码的时候喝冰美式');
  ok('extractKeywords 返回非空数组', Array.isArray(kw) && kw.length > 0, JSON.stringify(kw));
  ok('TYPE_BASE_WEIGHT 含五类', ['rule', 'preference', 'goal', 'emotion', 'fact'].every((k) => typeof core.TYPE_BASE_WEIGHT[k] === 'number'));
  ok('rule 权重最高', core.TYPE_BASE_WEIGHT.rule > core.TYPE_BASE_WEIGHT.fact);
}

// ─────────────────────────────────────────────────────────────
section('[3] 写入与去重合并');
// ─────────────────────────────────────────────────────────────
{
  const r1 = core.addFact(OWNER, { text: '主人喜欢在深夜喝冰美式，不加糖', type: 'preference', origin: 'qq' });
  ok('第一次写入新建卡片', r1.ok === true && r1.merged !== true, JSON.stringify(r1));

  const before = core.listCards(OWNER).length;
  const r2 = core.addFact(OWNER, { text: '主人喜欢在深夜喝冰美式，不加糖', type: 'preference', origin: 'qq' });
  const after = core.listCards(OWNER).length;
  ok('相同内容第二次写入被合并', r2.ok === true && r2.merged === true, JSON.stringify(r2));
  eq('卡片数量没有增加', after, before);

  const card = core.listCards(OWNER).find((c) => String(c.summary || '').indexOf('冰美式') >= 0);
  ok('卡片存在且 freq 已累加', !!card && Number(card.freq) >= 2, card ? 'freq=' + card.freq : 'not found');

  const f1 = core.addCardFact(card.id, '10 月 30 日说便利店的更好喝', 'qq');
  ok('可以给卡片挂细节', f1.ok === true, JSON.stringify(f1));
  ok('挂细节返回了 id', !!f1.id, JSON.stringify(f1));
  ok('细节写进了 facts.json', core.loadFacts().some((f) => f.card_id === card.id));

  const d1 = core.deleteCardFact(f1.id);
  ok('可以删除单条细节', d1.ok === true, JSON.stringify(d1));

  const r3 = core.addFact(OWNER, { text: '绝对不要在他面前提前任', type: 'rule', origin: 'qq' });
  ok('规则类写入成功', r3.ok === true, JSON.stringify(r3));
  const ruleCard = core.listCards(OWNER).find((c) => c.type === 'rule');
  ok('规则类自动 important', !!ruleCard && ruleCard.important === true);

  const r4 = core.addFact(OWNER, { text: '' });
  ok('空文本被拒绝', r4.ok === false, JSON.stringify(r4));
}

// ─────────────────────────────────────────────────────────────
section('[4] 权重与艾宾浩斯保留率');
// ─────────────────────────────────────────────────────────────
{
  const now = Date.now();
  const day = 86400000;

  const fresh = { type: 'fact', created: now, last_used: now, freq: 1 };
  const rFresh = core.cardRetention(fresh, now);
  ok('刚创建的卡片保留率接近 1', rFresh.retention > 0.98, 'got ' + rFresh.retention);

  const oldFact = { type: 'fact', created: now - 120 * day, last_used: now - 120 * day, freq: 1 };
  const rOld = core.cardRetention(oldFact, now);
  ok('120 天前的普通事实保留率已低于遗忘阈值', rOld.retention < core.EBBINGHAUS_FORGET_R, 'got ' + rOld.retention.toFixed(3));

  const oldRule = { type: 'rule', created: now - 120 * day, last_used: now - 120 * day, freq: 1 };
  const rRule = core.cardRetention(oldRule, now);
  ok('同样 120 天的规则保留率更高', rRule.retention > rOld.retention, rRule.retention.toFixed(3) + ' vs ' + rOld.retention.toFixed(3));

  const over = { type: 'fact', created: now - 500 * day, last_used: now - 500 * day, freq: 1, weightOverride: 1 };
  const plain = { type: 'fact', created: now - 500 * day, last_used: now - 500 * day, freq: 1 };
  const rOver = core.cardRetention(over, now);
  const rPlain = core.cardRetention(plain, now);
  ok('weightOverride=1 覆盖自动权重', rOver.weight === 1, 'w=' + rOver.weight);
  ok(
    '同样 500 天，手动权重 1 的保留率远高于普通事实',
    rOver.retention > rPlain.retention * 20,
    rOver.retention.toFixed(4) + ' vs ' + rPlain.retention.toFixed(6)
  );

  const imp = { type: 'fact', created: now - 3000 * day, last_used: now - 3000 * day, freq: 0, important: true };
  ok('important 卡片 weight 恒为 1', core.memoryWeight(imp) === 1);
  ok('important 卡片 retention 被标记 protected', core.cardRetention(imp, now).protected === true);

  const freqCard = { type: 'fact', created: now, last_used: now, freq: 20 };
  ok('高频卡权重被抬高但仍封顶', core.memoryWeight(freqCard) <= 0.81, 'got ' + core.memoryWeight(freqCard).toFixed(3));

  const report = core.retentionReport(OWNER);
  ok('retentionReport 返回报告对象', !!report && Array.isArray(report.rows), JSON.stringify(report && Object.keys(report)));
  ok('报告里有统计字段', typeof report.total === 'number' && typeof report.fading === 'number');
}

// ─────────────────────────────────────────────────────────────
section('[5] 遗忘 sweepMemory');
// ─────────────────────────────────────────────────────────────
{
  const now = Date.now();
  const day = 86400000;
  // 造一条注定被忘的卡
  const r = core.addFact(OWNER, { text: '前天在楼下便利店买了一把蓝色雨伞因为突然下雨了', type: 'fact' });
  ok('造一条待遗忘的日常事实', r.ok === true, JSON.stringify(r));
  const cards = core.loadCards();
  const victim = cards.find((c) => String(c.summary || '').indexOf('蓝色雨伞') >= 0);
  ok('找到这条卡片', !!victim);
  victim.created = now - 400 * day;
  victim.last_used = now - 400 * day;
  victim.freq = 1;
  victim.important = false;
  core.saveCards(cards);

  const dry = core.sweepMemory(now, { dryRun: true });
  ok('预演归档不真的改动', core.loadCards().some((c) => String(c.summary || '').indexOf('蓝色雨伞') >= 0));
  ok('预演报告里包含这条', (dry.items || []).some((c) => String(c.summary || '').indexOf('蓝色雨伞') >= 0), 'archived=' + dry.archived);
  ok('预演标记 dryRun', dry.dryRun === true && dry.archived >= 1);

  const real = core.sweepMemory(now, { dryRun: false });
  ok('执行后这条从活跃列表消失', !core.loadCards().some((c) => String(c.summary || '').indexOf('蓝色雨伞') >= 0), 'archived=' + real.archived);
  ok('但是文件里还在（软删除，没真删）', core.loadAllCards().some((c) => String(c.summary || '').indexOf('蓝色雨伞') >= 0));
  ok('归档卡带 archived 标记', !!core.archivedCards(OWNER).find((c) => String(c.summary || '').indexOf('蓝色雨伞') >= 0));
  ok('规则类卡片没有被动', core.loadCards().some((c) => c.type === 'rule'));
  ok('sweepMemory 返回归档数', typeof real.archived === 'number' && real.dryRun === false, JSON.stringify(Object.keys(real)));
  ok('stats.archived 计数正确', core.stats(OWNER).archived >= 1, 'archived=' + core.stats(OWNER).archived);

  // 手动恢复
  const arc = core.archivedCards(OWNER).find((c) => String(c.summary || '').indexOf('蓝色雨伞') >= 0);
  const rs = core.restoreCard(arc.id);
  ok('restoreCard 能把归档记忆拉回来', rs.ok === true, JSON.stringify(rs));
  ok('恢复后重新出现在活跃列表', core.loadCards().some((c) => c.id === arc.id));
  ok('对没归档的卡恢复会被拒绝', core.restoreCard(arc.id).ok === false);

  // 又提起同一条 → 自动复活（不产生重复卡）
  const aged = core.loadAllCards();
  for (const c of aged) {
    if (String(c.summary || '').indexOf('蓝色雨伞') >= 0) {
      c.created = now - 400 * day;
      c.last_used = now - 400 * day;
      c.freq = 1;
      c.important = false;
    }
  }
  core.saveCards(aged);
  core.sweepMemory(now, { dryRun: false });
  const arc2 = core.archivedCards(OWNER).find((c) => String(c.summary || '').indexOf('蓝色雨伞') >= 0);
  ok('先把它重新归档', !!arc2);
  const again = core.addFact(OWNER, { text: '前天在楼下便利店买了一把蓝色雨伞因为突然下雨了', type: 'fact' });
  ok('再次提起会复活归档卡', again.merged === true && again.revived === true, JSON.stringify(again));
  ok('复活后没有产生重复卡', core.loadCards().filter((c) => String(c.summary || '').indexOf('蓝色雨伞') >= 0).length === 1);
}

// ─────────────────────────────────────────────────────────────
section('[6] 检索与上下文注入');
// ─────────────────────────────────────────────────────────────
{
  core.addFact(OWNER, { text: '主人下周三要去杭州出差三天', type: 'goal' });
  core.addFact(OWNER, { text: '主人最讨厌别人在深夜给他打电话', type: 'preference' });

  const hits = core.searchByQuery(OWNER, '杭州', 5);
  ok('searchByQuery 能检索到相关卡片', hits.length > 0, 'hits=' + hits.length);
  ok('检索结果含目标卡片', hits.some((c) => String(c.summary || '').indexOf('杭州') >= 0));

  const ranked = core.rerank('出差安排', core.listCards(OWNER), 3);
  ok('rerank 返回不超过 3 条', ranked.length <= 3, 'got ' + ranked.length);

  const ctx = core.buildMemoryContext(OWNER, '他下周去哪', 2000);
  ok('buildMemoryContext 返回非空字符串', typeof ctx === 'string' && ctx.length > 0, 'len=' + String(ctx).length);
  ok('上下文不超过预算', ctx.length <= 2200, 'len=' + ctx.length);
  ok('上下文里出现了杭州', ctx.indexOf('杭州') >= 0);

  const tiny = core.buildMemoryContext(OWNER, '他下周去哪', 120);
  ok('预算很小时仍返回字符串且不崩溃', typeof tiny === 'string' && tiny.length <= 400, 'len=' + String(tiny).length);

  ok('getRecentCards 有序返回', Array.isArray(core.getRecentCards(OWNER, 5)));
  ok('getFreshCards 有序返回', Array.isArray(core.getFreshCards(OWNER, 5)));
  ok('buildFreshContext 返回字符串', typeof core.buildFreshContext(OWNER, 5, 600) === 'string');

  const edges = core.getRelatedEdges(core.listCards(OWNER), { maxEdges: 80, maxDeg: 4 });
  ok('getRelatedEdges 返回数组', Array.isArray(edges));
  ok('关联边形如 {a,b}', edges.every((e) => e && e.a && e.b));
  ok('关联边不含自环', edges.every((e) => e.a !== e.b));
  const pairs = new Set(edges.map((e) => (e.a < e.b ? e.a + '|' + e.b : e.b + '|' + e.a)));
  ok('关联边无重复', pairs.size === edges.length, pairs.size + ' vs ' + edges.length);
}

// ─────────────────────────────────────────────────────────────
section('[7] 关系图编辑');
// ─────────────────────────────────────────────────────────────
{
  // 群成员表有三种写法，最常用的是 {群号: {群友号: 名字}} 映射
  fs.writeFileSync(
    path.join(dataDir, 'members.json'),
    JSON.stringify({ '521708528': { '30003': '测试甲', '30004': '测试乙' } }),
    'utf8'
  );

  const rel0 = core.getRelations({ ownerId: OWNER, selfId: '20002', ownerName: '主人', selfName: '大肥鱼' });
  ok('getRelations 返回 nodes/edges', Array.isArray(rel0.nodes) && Array.isArray(rel0.edges));
  ok('含主人节点', rel0.nodes.some((n) => n.id === OWNER && n.role === 'owner'));
  ok('含大肥鱼节点', rel0.nodes.some((n) => n.id === '20002' && n.role === 'self'));
  ok('群成员（映射写法）被读出来', rel0.nodes.some((n) => n.id === '30003'), 'nodes=' + rel0.nodes.length);
  ok('群成员名字正确', (rel0.nodes.find((n) => n.id === '30003') || {}).name === '测试甲', JSON.stringify((rel0.nodes.find((n) => n.id === '30003') || {}).name));
  ok('群成员带默认的两种关系', (() => {
    const n = rel0.nodes.find((x) => x.id === '30003') || {};
    return n.ownerRel === '同群' && n.selfRel === '朋友';
  })(), JSON.stringify(rel0.nodes.find((x) => x.id === '30003')));

  const n1 = core.addRelationNode('小明明', 'friend');
  ok('可以新增人物节点', n1.ok === true, JSON.stringify(n1));
  const newId = n1.id || (n1.node && n1.node.id);
  ok('新增返回了 id', !!newId, JSON.stringify(n1));

  const rel1 = core.getRelations({ ownerId: OWNER, selfId: '20002' });
  ok('新人物出现在关系图里', rel1.nodes.some((n) => n.id === newId), 'id=' + newId);

  const rn = core.renameRelation(newId, '小明');
  ok('可以改名', rn.ok === true, JSON.stringify(rn));
  const rel2 = core.getRelations({ ownerId: OWNER, selfId: '20002' });
  const node2 = rel2.nodes.find((n) => n.id === newId);
  ok('改名生效', !!node2 && node2.name === '小明', node2 && node2.name);

  const rs = core.setRelationRels(newId, '大学室友', '熟悉的人');
  ok('可以设置主人关系/大肥鱼关系', rs.ok === true, JSON.stringify(rs));
  const rel3 = core.getRelations({ ownerId: OWNER, selfId: '20002' });
  const node3 = rel3.nodes.find((n) => n.id === newId);
  ok('主人关系生效', !!node3 && node3.ownerRel === '大学室友', node3 && node3.ownerRel);
  ok('大肥鱼关系生效', !!node3 && node3.selfRel === '熟悉的人', node3 && node3.selfRel);
  ok('两条边都进了 edges', rel3.edges.some((e) => e.from === OWNER && e.to === newId && e.rel === '大学室友'));

  const ae = core.addRelationEdge(OWNER, newId, '朋友');
  ok('可以手动连线', ae.ok === true, JSON.stringify(ae));
  const ad = core.addRelationEdge(OWNER, newId, '朋友');
  ok('重复连线不会重复写入', ad.ok === false && ad.reason === 'exists', JSON.stringify(ad));

  const de = core.deleteRelationEdge(OWNER, newId);
  ok('可以删除自定义连线', de.ok === true, JSON.stringify(de));

  const dn = core.deleteRelationNode(newId);
  ok('可以移除人物', dn.ok === true, JSON.stringify(dn));
  const rel4 = core.getRelations({ ownerId: OWNER, selfId: '20002' });
  ok('移除后不再出现', !rel4.nodes.some((n) => n.id === newId));

  const bad = core.deleteRelationNode(OWNER);
  ok('主人节点不可删除', bad.ok === false && bad.reason === 'protected', JSON.stringify(bad));
  const bad2 = core.deleteRelationNode('20002', { selfId: '20002' });
  ok('大肥鱼自己不可删除', bad2.ok === false && bad2.reason === 'protected', JSON.stringify(bad2));
}

// ─────────────────────────────────────────────────────────────
section('[8] 更新 / 删除 / 统计');
// ─────────────────────────────────────────────────────────────
{
  const card = core.listCards(OWNER)[0];
  const u1 = core.updateCard(card.id, { summary: '改过的摘要', weightOverride: 0.75 });
  ok('updateCard 成功', u1.ok === true, JSON.stringify(u1));
  const after = core.listCards(OWNER).find((c) => c.id === card.id);
  eq('摘要被更新', after.summary, '改过的摘要');
  eq('weightOverride 被写入', after.weightOverride, 0.75);

  const u2 = core.updateCard(card.id, { weightOverride: null });
  const after2 = core.listCards(OWNER).find((c) => c.id === card.id);
  ok('weightOverride 可以清空回自动', u2.ok === true && !(typeof after2.weightOverride === 'number'), JSON.stringify(after2 && after2.weightOverride));

  const u3 = core.updateCard('不存在的id', { summary: 'x' });
  ok('更新不存在的卡片返回失败', u3.ok === false, JSON.stringify(u3));

  // 删除一条不影响其它卡
  const before = core.listCards(OWNER).length;
  const target = core.listCards(OWNER)[0];
  const d = core.deleteCard(target.id);
  eq('deleteCard 只删一条', core.listCards(OWNER).length, before - 1);
  ok('deleteCard 返回 ok', d.ok === true, JSON.stringify(d));

  const st = core.stats(OWNER);
  ok('stats 返回对象', st && typeof st === 'object');
  ok('stats 有卡片数', typeof st.cards === 'number' || typeof st.total === 'number', JSON.stringify(Object.keys(st)));
  ok('getContextUsage 返回对象', !!core.getContextUsage());
  ok('listOwners 含写入者', core.listOwners().some((o) => String(o && o.id) === OWNER), JSON.stringify(core.listOwners()));
}

// ─────────────────────────────────────────────────────────────
section('[9] 提炼流水线（不联网，只测纯函数）');
// ─────────────────────────────────────────────────────────────
{
  ok('shouldExtract 拒绝过短文本', core.shouldExtract('嗯') === false);
  ok('shouldExtract 接受含信息的句子', core.shouldExtract('我从明天开始要去杭州出差三天，可能晚上没空回消息') === true);

  const prompt = core.buildExtractionPrompt('我从明天开始要去杭州出差三天');
  ok('buildExtractionPrompt 返回非空', typeof prompt === 'string' && prompt.length > 20);

  const parsed = core.parseExtraction('```json\n{"facts":[{"type":"goal","text":"主人明天起去杭州出差三天"}]}\n```');
  ok('parseExtraction 能从代码块里取出 facts', Array.isArray(parsed) && parsed.length === 1, JSON.stringify(parsed));
  ok('parseExtraction 保留类型', parsed[0] && parsed[0].type === 'goal');

  const bad = core.parseExtraction('这不是 JSON');
  ok('parseExtraction 对垃圾输入返回空数组', Array.isArray(bad) && bad.length === 0);

  const noFacts = core.parseExtraction('{"facts":[]}');
  ok('parseExtraction 空列表返回空数组', Array.isArray(noFacts) && noFacts.length === 0);
}

// ─────────────────────────────────────────────────────────────
section('[10] Host 半侧：路由注册 + 注入 + handler');
// ─────────────────────────────────────────────────────────────
{
  const plugin = require('../lib/index.js');
  ok('index.js 导出插件对象', !!plugin && typeof plugin.apply === 'function');
  ok('插件声明 inject 含 webServer', Array.isArray(plugin.inject) && plugin.inject.indexOf('webServer') >= 0);

  const routes = [];
  const tools = [];
  let tap = null;
  const fakeWs = {
    register(route) {
      routes.push(route);
      return () => {};
    },
    tapIndex(fn) {
      tap = fn;
      return () => {};
    },
  };
  const fakeCtx = {
    effect(fn) {
      return fn();
    },
    get(name) {
      return name === 'webServer' ? fakeWs : undefined;
    },
    tools: {
      register(def) {
        tools.push(def);
        return () => {};
      },
    },
  };

  plugin.apply(fakeCtx, {
    dataDir: dataDir,
    ownerId: OWNER,
    selfId: '20002',
    ownerName: '主人',
    selfName: '大肥鱼',
  });

  ok('注册了 API 前缀路由', routes.some((r) => r.kind === 'prefix' && r.path === '/dayu-memory-star/api'));
  ok('注册了 client.js 路由', routes.some((r) => r.kind === 'exact' && r.path === '/dayu-memory-star/client.js'));
  ok('注册了 icon.svg 路由', routes.some((r) => r.kind === 'exact' && r.path === '/dayu-memory-star/icon.svg'));
  ok('调用了 tapIndex 注入首屏', typeof tap === 'function');
  ok('注册了两个智能体工具', tools.length === 2, 'got ' + tools.length);
  ok(
    '工具名正确',
    tools.map((t) => t.name).sort().join(',') === 'dayu_memory_remember,dayu_memory_search',
    tools.map((t) => t.name).join(',')
  );

  // 注入脚本
  const html = tap('<html><body><div id="app"></div></body></html>');
  ok('注入后含标记 data-dayu-memory-star', html.indexOf('data-dayu-memory-star') >= 0);
  ok('注入后含 client.js', html.indexOf('/dayu-memory-star/client.js') >= 0);
  ok('注入后含 __DAYU_MEMORY_STAR__ 引导对象', html.indexOf('__DAYU_MEMORY_STAR__') >= 0);
  const again = tap(html);
  eq('重复注入是幂等的', (again.match(/data-dayu-memory-star/g) || []).length, 1);
  ok('没有 </body> 时也能注入', tap('<div>x</div>').indexOf('data-dayu-memory-star') >= 0);

  // 假 req/res
  function makeRes() {
    return {
      statusCode: 0,
      headers: {},
      body: '',
      writeHead(code, headers) {
        this.statusCode = code;
        Object.assign(this.headers, headers || {});
      },
      end(chunk) {
        if (chunk) this.body += String(chunk);
      },
    };
  }
  function makeReq(method, url, body) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.destroy = () => {};
    process.nextTick(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
    return req;
  }

  const api = routes.find((r) => r.kind === 'prefix' && r.path === '/dayu-memory-star/api');
  async function call(method, suffix, body) {
    const res = makeRes();
    await api.handler(makeReq(method, '/dayu-memory-star/api' + suffix, body), res);
    let json = null;
    try {
      json = JSON.parse(res.body);
    } catch {
      json = null;
    }
    return { status: res.statusCode, json, raw: res.body, headers: res.headers };
  }

  (async () => {
    const all = await call('GET', '/all');
    eq('GET /all 返回 200', all.status, 200);
    ok('GET /all 是 JSON', (all.headers['content-type'] || '').indexOf('application/json') >= 0);
    ok('GET /all 含 cards 数组', Array.isArray(all.json.cards));
    ok('GET /all 含 relatedEdges', Array.isArray(all.json.relatedEdges));
    ok('GET /all 含 relations', !!all.json.relations && Array.isArray(all.json.relations.nodes));
    ok('GET /all 含 context', !!all.json.context);
    ok('GET /all 的卡片带 retention', all.json.cards.every((c) => typeof c.retention === 'number'));
    ok('GET /all 的卡片带 name', all.json.cards.every((c) => typeof c.name === 'string' && c.name.length > 0));

    const st = await call('GET', '/status');
    eq('GET /status 返回 200', st.status, 200);
    ok('GET /status 含 stats', !!st.json.stats);
    ok('未配置 bridgeUrl 时 bridge.available=false', st.json.bridge && st.json.bridge.available === false);

    const cx = await call('GET', '/context?q=' + encodeURIComponent('杭州') + '&budget=800');
    eq('GET /context 返回 200', cx.status, 200);
    ok('GET /context 返回 text', typeof cx.json.text === 'string' && cx.json.text.length > 0);

    const rem = await call('POST', '/remember', { text: '主人最近在学做手冲咖啡', type: 'preference' });
    eq('POST /remember 返回 200', rem.status, 200);
    ok('POST /remember 写入成功', rem.json.ok === true, JSON.stringify(rem.json));

    const all2 = await call('GET', '/all');
    ok('新记忆出现在 /all 里', all2.json.cards.some((c) => String(c.summary || '').indexOf('手冲咖啡') >= 0));

    const sr = await call('POST', '/search', { query: '咖啡', topN: 5 });
    ok('POST /search 能检索到', sr.json.cards && sr.json.cards.length > 0, JSON.stringify(sr.json).slice(0, 120));

    const up = await call('POST', '/card/update', { id: all2.json.cards[0].id, patch: { important: true } });
    ok('POST /card/update 成功', up.json.ok === true, JSON.stringify(up.json));

    const sw = await call('POST', '/sweep', { dryRun: true });
    ok('POST /sweep 预演成功', sw.json.ok === true, JSON.stringify(sw.json));
    ok('POST /sweep 返回归档字段', typeof sw.json.archived === 'number', JSON.stringify(sw.json));

    const arch = await call('GET', '/archived');
    ok('GET /archived 返回列表', arch.json.ok === true && Array.isArray(arch.json.cards), JSON.stringify(arch.json).slice(0, 120));

    const restoreMiss = await call('POST', '/card/restore', { id: 'not-exist' });
    ok('POST /card/restore 对不存在的卡返回 ok:false', restoreMiss.json.ok === false, JSON.stringify(restoreMiss.json));

    const rel = await call('POST', '/relations/addNode', { name: '测试人物', role: 'friend' });
    ok('POST /relations/addNode 成功', rel.json.ok === true, JSON.stringify(rel.json));

    const nf = await call('GET', '/nope');
    eq('未知 GET 端点返回 404', nf.status, 404);
    const nf2 = await call('POST', '/nope', {});
    eq('未知 POST 端点返回 404', nf2.status, 404);

    // client.js / icon 路由
    const cRes = makeRes();
    routes.find((r) => r.path === '/dayu-memory-star/client.js').handler(makeReq('GET', '/dayu-memory-star/client.js'), cRes);
    ok('client.js 路由返回非空 JS', cRes.body.length > 5000, 'len=' + cRes.body.length);
    ok('client.js 内容像浏览器脚本', cRes.body.indexOf('__ModuleLoader__') >= 0 || cRes.body.indexOf('document.') >= 0);

    const iRes = makeRes();
    routes.find((r) => r.path === '/dayu-memory-star/icon.svg').handler(makeReq('GET', '/dayu-memory-star/icon.svg'), iRes);
    ok('icon.svg 路由返回 SVG', iRes.body.indexOf('<svg') === 0, iRes.body.slice(0, 20));

    // 工具 execute 冒烟
    const searchTool = tools.find((t) => t.name === 'dayu_memory_search');
    const sres = await searchTool.execute({ query: '咖啡', top_n: 3 });
    ok('dayu_memory_search 返回 content', !!sres && Array.isArray(sres.content) && sres.content[0].type === 'text');

    const rememberTool = tools.find((t) => t.name === 'dayu_memory_remember');
    const rres = await rememberTool.execute({ text: '主人说下周要去杭州出差', type: 'goal' });
    ok('dayu_memory_remember 返回 content', !!rres && Array.isArray(rres.content) && rres.content[0].type === 'text');

    // ── 收尾 ──
    section('[11] 数据落盘校验');
    ok('cards.json 存在', fs.existsSync(path.join(dataDir, 'cards.json')));
    ok('facts.json 存在', fs.existsSync(path.join(dataDir, 'facts.json')));
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'cards.json'), 'utf8'));
    ok('cards.json 是合法 JSON 数组', Array.isArray(raw));
    ok('卡片含 owner_id', raw.every((c) => typeof c.owner_id === 'string'));

    // ── v1.1.0：添加卡片自动归类 + 自动连线 ──
    section('[12] 添加卡片：自动归类 + 自动连线');
    {
      // 先种一条语义相邻的记忆，保证「自动连线」有可连的对象
      const seed = core.addCard('10001', { summary: '主人喜欢在雨夜听歌', type: 'auto' });
      ok('种子卡创建成功', !!seed && seed.ok === true);

      const before = core.listCards('10001').length;
      const res = core.addCard('10001', { summary: '主人喜欢在雨夜听老歌', type: 'auto' });
      ok('addCard 返回 ok', !!res && res.ok === true);
      ok('type=auto 自动判断为偏好', res.type === 'preference', String(res.type));
      ok('返回相关记忆列表', Array.isArray(res.related) && res.related.length >= 1, 'related=' + (res.related || []).length);
      ok('相关项带短名', !!(res.related[0] && res.related[0].name), String(res.related[0] && res.related[0].name));

      const after = core.listCards('10001');
      ok('卡片数 +1', after.length === before + 1, before + ' → ' + after.length);
      const fresh = after.find((c) => c.id === res.id);
      ok('新卡写了 keywords', !!fresh && Array.isArray(fresh.keywords) && fresh.keywords.length > 0);
      ok('新卡写了 linked_to', !!fresh && Array.isArray(fresh.linked_to) && fresh.linked_to.length >= 1);

      const edges = core.getRelatedEdges(after, { maxEdges: 400 });
      const autoEdges = edges.filter((e) => e.via === 'auto');
      ok('getRelatedEdges 含自动连线', autoEdges.length >= 1, 'auto=' + autoEdges.length);
      ok('自动连线挂在新卡上', autoEdges.some((e) => e.a === res.id || e.b === res.id));

      const del = core.deleteCard(res.id);
      ok('测试卡可删除', !!del && del.ok === true);
      core.deleteCard(seed.id);
    }

    // ── v1.1.0：短名与中心星候选 ──
    section('[13] 短名 / 中心星候选');
    {
      const nm = core.shortName('主人喜欢大肥鱼用颜文字和表情包');
      ok('短名不超过 11 字且以省略号结尾', nm.length <= 11 && nm.slice(-1) === '…', nm);
      ok('短名保留开头 10 字', nm === '主人喜欢大肥鱼用颜文…', nm);
      ok('空摘要给默认名', core.shortName('') === '未命名记忆');
      const cands = core
        .listCards('10001')
        .filter((c) => /生日/.test(c.summary || '') && /主人/.test(c.summary || '') && !/大肥鱼/.test(c.summary || ''));
      ok('中心星候选筛选不报错', Array.isArray(cands));
    }

    console.log('\n' + '─'.repeat(60));
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail) {
      console.log('\n失败项：');
      failures.forEach((f) => console.log('  · ' + f));
    }
    console.log('数据目录：' + dataDir);

    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    process.exit(fail ? 1 : 0);
  })().catch((err) => {
    console.error('\n冒烟测试异常：', err);
    process.exit(1);
  });
}
