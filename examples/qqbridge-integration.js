'use strict';
/**
 * 示例：把「记忆星图」的记忆模型接进你自己的 QQBridge / Node 机器人。
 *
 * 不需要装 DSH —— memory-core.js 是单文件零依赖 CJS 模块。
 * 只需要三处改动：
 *   1. 说话前：用 buildMemoryContext 取记忆，塞进 system（替代把聊天记录整个塞进去）
 *   2. 说话后：shouldExtract + extractMemory + addFact 写记忆
 *   3. 定时：sweepMemory 按艾宾浩斯曲线遗忘
 *
 * 运行：node examples/qqbridge-integration.js（会跑一遍离线演示，不联网）
 */

const path = require('node:path');
const Mem = require('../lib/memory-core.js');

// ── 1. 配置：指向你的记忆目录（老部署直接指过去就行） ──────────
const OWNER_UIN = process.env.OWNER_UIN || '3387982960';
Mem.configure({
  dataDir: process.env.DAYU_MEMORY_DIR || path.join(__dirname, '..', '.demo-memory'),
  ownerId: OWNER_UIN,
});

// ── 2. 灵魂设定：永不被裁剪的那一层 ────────────────────────────
const SOUL = [
  '你叫「大肥鱼」，一条会记住事情的大肥鱼。',
  '对主人温柔、话少但贴心；对别人礼貌但有边界。',
  '不要提主人的隐私。',
].join('\n');

/**
 * 组装这一轮要发给模型的 messages。
 * 注意：长期信息全部来自记忆库，聊天历史只留最近几条做语气连贯。
 */
function buildMessages(userText, recentHistory, callLLM) {
  const memCtx = Mem.buildMemoryContext(OWNER_UIN, userText, 2000);
  return [
    { role: 'system', content: SOUL + (memCtx ? '\n\n' + memCtx : '') },
    ...(recentHistory || []).slice(-10),
    { role: 'user', content: userText },
  ];
}

/**
 * 回复之后写记忆。
 * callLLM 是「把 prompt 变成文本」的函数，签名 (messages, opts) => Promise<string>。
 * 没接 LLM 也没关系：shouldExtract 会先挡掉闲聊，剩下的走关键词兜底分类。
 */
async function rememberAfterReply(userText, aiReply, callLLM, speakerLabel) {
  if (!Mem.shouldExtract(userText)) return [];
  let facts = [];
  if (typeof callLLM === 'function') {
    try {
      facts = await Mem.extractMemory(userText, aiReply, callLLM, speakerLabel);
    } catch {
      facts = [];
    }
  }
  if (!facts.length) {
    // 兜底：不调 LLM，直接按关键词分类存一条
    facts = [{ type: Mem.classifyByKeyword(userText), text: String(userText).slice(0, 60) }];
  }
  const written = [];
  for (const f of facts) {
    const r = Mem.addFact(OWNER_UIN, { type: f.type, text: f.text, origin: 'qq' });
    if (r && r.ok) written.push(r);
  }
  return written;
}

// ── 3. 定时遗忘（建议 5 分钟一次；也可以只在状态页手动执行） ─────
function startMaintenance(intervalMs) {
  const timer = setInterval(() => {
    const r = Mem.sweepMemory();
    if (r && r.dropped) console.log('[记忆] 遗忘 ' + r.dropped + ' 条');
  }, intervalMs || 5 * 60 * 1000);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { Mem, OWNER_UIN, SOUL, buildMessages, rememberAfterReply, startMaintenance };

// ── 4. 离线演示（直接 node 跑这个文件时执行） ───────────────────
if (require.main === module) {
  (async () => {
    console.log('记忆目录：' + Mem.dataDir());
    console.log('现有卡片：' + Mem.listCards(OWNER_UIN).length + ' 条\n');

    const samples = [
      '我最喜欢深夜写代码的时候喝冰美式，不加糖',
      '我最喜欢深夜写代码的时候喝冰美式，不加糖', // 重复一次，验证去重合并
      '绝对不要在我面前提前任，这是雷区',
      '下周三要去杭州出差三天，可能晚上没空回消息',
      '今天被领导表扬了，特别开心',
    ];

    for (const s of samples) {
      const w = await rememberAfterReply(s, '', null, '主人');
      const first = w[0];
      console.log('写入 ' + (first && first.merged ? '[合并]' : '[新增]') + ' ' + s.slice(0, 20));
    }

    const cards = Mem.listCards(OWNER_UIN);
    console.log('\n现在共 ' + cards.length + ' 条记忆：');
    for (const c of cards.slice(-6)) {
      const r = Mem.cardRetention(c);
      console.log(
        '  · [' + (Mem.TYPE_LABEL[c.type] || '日常') + '] ' + String(c.summary).slice(0, 28) +
        '  权重 ' + r.weight.toFixed(2) + '  保留率 ' + (r.retention * 100).toFixed(1) + '%' +
        (r.protected ? '  (受保护)' : '')
      );
    }

    const ctxText = Mem.buildMemoryContext(OWNER_UIN, '他下周去哪', 800);
    console.log('\n注入用的上下文（' + ctxText.length + ' 字）：\n' + ctxText);

    console.log('\n关系图：' + Mem.getRelations({ ownerId: OWNER_UIN }).nodes.length + ' 个节点');
    console.log('关联边：' + Mem.getRelatedEdges(cards, { maxEdges: 80, maxDeg: 4 }).length + ' 条');
    console.log('\n演示结束。这次写的是 ' + Mem.dataDir() + '，删掉即可清理。');
  })();
}
