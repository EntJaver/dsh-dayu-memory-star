'use strict';
/**
 * dsh-dayu-memory-star / memory-core
 * ---------------------------------------------------------------
 * 零依赖的「长期记忆」模型。它不绑定任何一家 SDK、不联网、不需要向量库：
 * 全部计算（相似度、去重、遗忘、检索、上下文拼装）都在本地纯 JS 里完成。
 *
 * 设计取向
 *   1) 摘要索引（cards）+ 细节外挂（facts）两级存储，省 Token。
 *   2) 艾宾浩斯遗忘曲线 + 权重系统：日常寒暄会自然淡出，规则/偏好/情感留得住。
 *   3) 上下文从「记忆库」里取，而不是把最近几十条聊天记录整段塞回去。
 *   4) 全部是普通 JSON 文件，可以被任何宿主（QQBridge / AstrBot / 自研 bot）读写。
 *
 * 目录约定（与 dataDir 同级，或 dataDir 的上一级）
 *   cards.json            摘要卡片  [{id, owner_id, type, summary, keywords, important, freq, created, last_used, weightOverride, snippet}]
 *   facts.json            细节外挂  [{id, card_id, fact, origin, ts}]
 *   members.json          人物表（可选，给关系图用）
 *   context_usage.json    上下文用量（可选，宿主自己写的统计）
 *   owner_profile.json    主人画像（可选）
 *   self_profile.json     智能体自我画像（可选）
 *   relations_extra.json  关系图手工增量（本插件写入）
 *
 * @module dsh-dayu-memory-star/memory-core
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 卡片类型 → 基础权重。rule 最高，fact（日常碎片）最低。 */
const TYPE_BASE_WEIGHT = { rule: 1.0, preference: 0.9, goal: 0.85, emotion: 0.8, fact: 0.45 };

/** 卡片类型的展示名 */
const TYPE_LABEL = { rule: '规则', preference: '偏好', goal: '目标', emotion: '情感', fact: '日常' };

/** 艾宾浩斯曲线：权重 1.0 的记忆，稳定期 = 90 天 */
const EBBINGHAUS_S_DAY = 90;
/** 保留率低于这个值 → 遗忘 */
const EBBINGHAUS_FORGET_R = 0.2;
/** 被反复用到这么多次 → 免除遗忘 */
const EBBINGHAUS_FORGET_FREQ = 4;

/** 合并同一张卡片的相似度阈值 */
const MERGE_SIM = 0.85;
/** 判定「两张卡有关联」的相似度阈值 */
const RELATED_SIM = 0.3;

const STORAGE = {
  cards: 'cards.json',
  facts: 'facts.json',
  members: 'members.json',
  usage: 'context_usage.json',
  ownerProfile: 'owner_profile.json',
  selfProfile: 'self_profile.json',
  relExtra: 'relations_extra.json',
};

/** 常驻灵魂设定：每次拼上下文都带，保证人格不漂移 */
const SOUL = [
  '你是一个有长期记忆的数字生命。下面这些是你的记忆库，不是聊天记录。',
  '关于主人/用户的事实以记忆库为准；记忆库里没有的，就不要编。',
  '记忆库顶部标注「最新」的条目才代表对方现在的情况；新旧冲突时以新为准。',
];

/** 实际使用的灵魂设定：用户在配置里改过就用他的 */
function soulLines() {
  return Array.isArray(state.soul) && state.soul.length ? state.soul : SOUL;
}

/** 把配置里的 soul（数组 / 换行或竖线分隔的字符串）规整成数组 */
function parseSoul(v) {
  if (Array.isArray(v)) {
    const out = v.map((s) => String(s).trim()).filter(Boolean);
    return out.length ? out : null;
  }
  if (typeof v === 'string' && v.trim()) {
    const out = v.split(/\r?\n|\|/).map((s) => s.trim()).filter(Boolean);
    return out.length ? out : null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

const now = () => Date.now();
const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

function expandHome(p) {
  if (typeof p !== 'string' || !p) return '';
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = String(x).toLowerCase();
    if (!x || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

let idSeq = 0;
function nextId(prefix) {
  idSeq = (idSeq + 1) % 100000;
  return prefix + now().toString(36) + idSeq.toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─────────────────────────────────────────────────────────────
// 数据目录自适应
// ─────────────────────────────────────────────────────────────

const state = {
  /** 用户显式指定的目录（配置项 dataDir） */
  explicitDir: '',
  /** 最终解析出来的目录 */
  dataDir: '',
  ownerId: '',
  /** 解析依据，给「状态」页展示，便于用户排查 */
  resolvedBy: '',
  /** 自定义灵魂设定（配置项 soul；null = 用默认 SOUL） */
  soul: null,
};

/** 候选目录（按优先级） */
function candidateDirs(explicit) {
  const list = [];
  if (explicit) list.push(path.resolve(expandHome(String(explicit))));
  if (process.env.DAYU_MEMORY_DIR) list.push(path.resolve(expandHome(process.env.DAYU_MEMORY_DIR)));
  const home = os.homedir();
  // 官方默认
  list.push(path.join(home, '.dsh', 'dayu-memory'));
  // 常见的自建部署约定
  list.push(path.join(home, '.dayu-memory', 'memory'));
  list.push(path.join(home, '.dayu-memory'));
  // 当前工作目录下的约定
  list.push(path.join(process.cwd(), 'memory'));
  list.push(path.join(process.cwd(), 'data', 'memory'));
  list.push(path.join(process.cwd(), 'dayu-memory'));
  // 临时目录里的老部署（早期大肥鱼 bot 就放在这里）
  const tmp = process.env.TEMP || process.env.TMP;
  if (tmp) {
    list.push(path.join(tmp, 'ds-shichuan', 'memory'));
    list.push(path.join(tmp, 'ds-shichuan'));
  }
  return uniq(list);
}

/**
 * 解析记忆目录。显式配置 > 环境变量 > 已存在的候选 > 默认创建。
 * @param {string} [explicit]
 * @param {{ force?: boolean }} [opts]
 */
function resolveDataDir(explicit, opts) {
  const force = !!(opts && opts.force);
  if (!force && state.dataDir && state.dataDir === (explicit ? path.resolve(expandHome(String(explicit))) : state.dataDir)) {
    return state.dataDir;
  }
  state.explicitDir = explicit ? path.resolve(expandHome(String(explicit))) : '';
  const list = candidateDirs(state.explicitDir);

  // 1) 显式目录：无论有没有数据都用它
  if (state.explicitDir) {
    state.dataDir = state.explicitDir;
    state.resolvedBy = 'config.dataDir';
    return state.dataDir;
  }
  // 2) 环境变量
  if (process.env.DAYU_MEMORY_DIR) {
    state.dataDir = path.resolve(expandHome(process.env.DAYU_MEMORY_DIR));
    state.resolvedBy = 'env.DAYU_MEMORY_DIR';
    return state.dataDir;
  }
  // 3) 已有数据文件的候选
  for (const dir of list) {
    if (fileExists(path.join(dir, STORAGE.cards)) || fileExists(path.join(dir, STORAGE.facts))) {
      state.dataDir = dir;
      state.resolvedBy = 'auto-detected';
      return state.dataDir;
    }
  }
  // 4) 默认位置
  state.dataDir = path.join(os.homedir(), '.dsh', 'dayu-memory');
  state.resolvedBy = 'default';
  return state.dataDir;
}

function configure(cfg) {
  const c = cfg || {};
  resolveDataDir(c.dataDir, { force: true });
  state.ownerId = c.ownerId ? String(c.ownerId) : '';
  // 灵魂设定可换：别的部署不一定叫大肥鱼
  const soul = parseSoul(c.soul) || parseSoul(process.env.DAYU_SOUL);
  state.soul = soul;
  return state.dataDir;
}

function dataDir() {
  if (!state.dataDir) resolveDataDir(state.explicitDir);
  return state.dataDir;
}

/** 找同级 / 上一级的附属文件（兼容 memory/ 子目录的部署） */
function siblingPath(name) {
  const d = dataDir();
  const a = path.join(d, name);
  if (fileExists(a)) return a;
  const b = path.join(path.dirname(d), name);
  if (fileExists(b)) return b;
  return a; // 不存在时返回首选路径，写入会建在 dataDir 下
}

// ─────────────────────────────────────────────────────────────
// 相似度引擎（字符 3-gram + MinHash + Jaccard，纯本地）
// ─────────────────────────────────────────────────────────────

const MINHASH_SEEDS = (() => {
  const out = [];
  let s = 0x9e3779b9;
  for (let i = 0; i < 32; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out.push(s | 1);
  }
  return out;
})();

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 去虚词：让「火锅」和「火锅了」能撞上 */
function normalize(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[的了啊呢吧吗呀嘛啥哦喔嘻呐]/g, '');
}

/** 字符 n-gram 集合，只保留汉字与字母数字 */
function shingles(text, n) {
  const k = n || 3;
  const s = normalize(text).replace(/[^\p{Script=Han}a-z0-9]+/gu, '');
  const out = new Set();
  if (!s) return out;
  if (s.length <= k) {
    out.add(s);
    return out;
  }
  for (let i = 0; i + k <= s.length; i++) out.add(s.slice(i, i + k));
  return out;
}

function jaccard(a, b) {
  const A = a instanceof Set ? a : shingles(a);
  const B = b instanceof Set ? b : shingles(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function minhashSignature(text) {
  const sig = new Array(MINHASH_SEEDS.length).fill(0xffffffff);
  for (const sh of shingles(text)) {
    const base = fnv1a(sh);
    for (let i = 0; i < MINHASH_SEEDS.length; i++) {
      const v = (base ^ MINHASH_SEEDS[i]) >>> 0;
      if (v < sig[i]) sig[i] = v;
    }
  }
  return sig;
}

function sigSimilarity(a, b) {
  let same = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
  return n ? same / n : 0;
}

/** 综合相似度：MinHash 容忍增删，Jaccard 保证精确重合 */
function similarity(a, b) {
  if (!a || !b) return 0;
  const na = String(a).trim();
  const nb = String(b).trim();
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return 0.5 * sigSimilarity(minhashSignature(na), minhashSignature(nb)) + 0.5 * jaccard(na, nb);
}

// ─────────────────────────────────────────────────────────────
// 分类与关键词
// ─────────────────────────────────────────────────────────────

const TYPE_KEYWORDS = [
  { type: 'rule', re: /不要|不准|不许|必须|禁止|记住|以后要|以后别|规定|约定|答应|承诺|雷区|底线|只能|一定要/g },
  { type: 'goal', re: /目标|计划|打算|准备要|想要|希望|正在学|要考|项目|ddl|截止|攒钱|减肥|练习|面试|出差|报名|搬家|考试/g },
  { type: 'preference', re: /喜欢|最爱|爱吃|爱喝|讨厌|不喜欢|偏好|习惯|口味|常去|常用|受不了/g },
  { type: 'emotion', re: /开心|高兴|难过|伤心|生气|委屈|害怕|焦虑|紧张|感动|孤独|兴奋|害怕|崩溃|emo/gi },
];

/** 关键词兜底分类（LLM 不可用 / 返回不合法时用） */
function classifyByKeyword(text) {
  const t = String(text == null ? '' : text);
  if (!t) return 'fact';
  for (const k of TYPE_KEYWORDS) {
    k.re.lastIndex = 0;
    if (k.re.test(t)) return k.type;
  }
  return 'fact';
}

/** 从文本里取关键词（2-gram 频次最高者），用于关系图找关联 */
function extractKeywords(text, limit) {
  const lim = limit || 6;
  const s = normalize(text).replace(/[^\p{Script=Han}a-z0-9]+/gu, '');
  if (s.length < 2) return s ? [s] : [];
  const freq = new Map();
  for (let i = 0; i + 2 <= s.length; i++) {
    const g = s.slice(i, i + 2);
    freq.set(g, (freq.get(g) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, lim)
    .map((x) => x[0]);
}

// ─────────────────────────────────────────────────────────────
// 存储
// ─────────────────────────────────────────────────────────────

function cardsPath() {
  return path.join(dataDir(), STORAGE.cards);
}
function factsPath() {
  return path.join(dataDir(), STORAGE.facts);
}

function loadCards() {
  const v = readJson(cardsPath(), []);
  return Array.isArray(v) ? v : [];
}
function saveCards(cards) {
  writeJson(cardsPath(), Array.isArray(cards) ? cards : []);
}
function loadFacts() {
  const v = readJson(factsPath(), []);
  return Array.isArray(v) ? v : [];
}
function saveFacts(facts) {
  writeJson(factsPath(), Array.isArray(facts) ? facts : []);
}

// ─────────────────────────────────────────────────────────────
// 权重与遗忘（艾宾浩斯）
// ─────────────────────────────────────────────────────────────

/**
 * 一张卡片的「重要性权重」0~1。
 * 手动覆盖 > important 标记 > 类型基础权重 + 使用频率加成。
 */
function memoryWeight(card) {
  if (!card) return 0;
  if (typeof card.weightOverride === 'number' && !Number.isNaN(card.weightOverride)) {
    return clamp01(card.weightOverride);
  }
  if (card.important) return 1;
  const base = TYPE_BASE_WEIGHT[card.type] != null ? TYPE_BASE_WEIGHT[card.type] : TYPE_BASE_WEIGHT.fact;
  const freqBonus = Math.min(12, Math.max(0, Number(card.freq) || 0)) * 0.03;
  return clamp01(base + freqBonus);
}

/**
 * 艾宾浩斯保留率。
 *   S（稳定期）= 权重 × 90 天
 *   R(t) = e^(-t / S)
 * 越重要的记忆衰减越慢；被反复回忆（freq 高）的记忆权重更高 → 更慢。
 */
function cardRetention(card, at) {
  const t = at || now();
  const weight = memoryWeight(card);
  const stabilityDays = Math.max(1, weight * EBBINGHAUS_S_DAY);
  const created = Number(card && card.created) || t;
  const lastUsed = Number(card && card.last_used) || 0;
  // 以「最后一次被想起」为起点计时：想得起 = 复习过
  const anchor = Math.max(created, lastUsed);
  const ageDays = Math.max(0, (t - anchor) / 86400000);
  const retention = Math.exp(-ageDays / stabilityDays);
  return {
    weight: Number(weight.toFixed(4)),
    stabilityDays: Number(stabilityDays.toFixed(2)),
    ageDays: Number(ageDays.toFixed(2)),
    retention: Number(retention.toFixed(4)),
    forgetting: retention < EBBINGHAUS_FORGET_R,
    protected: !!(card && card.important) || (Number(card && card.freq) || 0) >= EBBINGHAUS_FORGET_FREQ,
  };
}

/** 全量保留率报告 */
function retentionReport(ownerId, at) {
  const cards = loadCards().filter((c) => !ownerId || c.owner_id === ownerId);
  const t = at || now();
  const rows = cards.map((c) => {
    const r = cardRetention(c, t);
    return { id: c.id, summary: c.summary || '', type: c.type || 'fact', ...r };
  });
  rows.sort((a, b) => a.retention - b.retention);
  return {
    total: rows.length,
    fading: rows.filter((r) => r.forgetting).length,
    important: cards.filter((c) => c.important).length,
    soonest: rows.slice(0, 8),
    rows,
  };
}

/**
 * 遗忘扫描：删掉保留率低于阈值的记忆（important 与高频记忆免疫）。
 * @param {number} [at]
 * @param {{ dryRun?: boolean, ownerId?: string }} [opts]
 */
function sweepMemory(at, opts) {
  const o = opts || {};
  const t = at || now();
  const cards = loadCards();
  const facts = loadFacts();
  const byId = new Map(cards.map((c) => [c.id, c]));
  const drop = [];
  for (const c of cards) {
    if (o.ownerId && c.owner_id !== o.ownerId) continue;
    if (c.important) continue;
    if ((Number(c.freq) || 0) >= EBBINGHAUS_FORGET_FREQ) continue;
    const r = cardRetention(c, t);
    if (r.retention < EBBINGHAUS_FORGET_R) {
      drop.push({ id: c.id, summary: c.summary || '', retention: r.retention, type: c.type || 'fact' });
    }
  }
  if (o.dryRun || !drop.length) {
    return { dropped: drop.length, items: drop, dryRun: !!o.dryRun };
  }
  const dropIds = new Set(drop.map((d) => d.id));
  saveCards(cards.filter((c) => !dropIds.has(c.id)));
  saveFacts(facts.filter((f) => !dropIds.has(f.card_id)));
  return { dropped: drop.length, items: drop, dryRun: false, factsPruned: facts.length - loadFacts().length, known: byId.size };
}

// ─────────────────────────────────────────────────────────────
// 写入
// ─────────────────────────────────────────────────────────────

/**
 * 写入一条记忆。相似度 ≥ 0.85 时并入已有卡片（补细节、抬频率），否则新建。
 * @param {string} ownerId
 * @param {{text:string,type?:string,important?:boolean,origin?:string,speaker?:string}} item
 */
function addFact(ownerId, item) {
  const it = item || {};
  const text = String(it.text == null ? '' : it.text).trim();
  if (!text) return { ok: false, reason: 'empty' };

  const cards = loadCards();
  const facts = loadFacts();
  const owner = String(ownerId || state.ownerId || 'default');

  let best = null;
  let bestSim = 0;
  for (const c of cards) {
    if (c.owner_id !== owner) continue;
    const sim = similarity(c.summary, text);
    if (sim > bestSim) {
      bestSim = sim;
      best = c;
    }
  }

  if (best && bestSim >= MERGE_SIM) {
    if (bestSim < 0.98) best.summary = text; // 用更新的说法替换摘要
    best.freq = (Number(best.freq) || 0) + 1;
    best.last_used = now();
    const type = it.type || classifyByKeyword(text);
    if (type && type !== 'fact') best.type = type;
    if (it.important) best.important = true;
    facts.push({
      id: nextId('f_'),
      card_id: best.id,
      fact: text,
      origin: it.origin || it.speaker || '',
      ts: now(),
    });
    saveCards(cards);
    saveFacts(facts);
    return { ok: true, merged: true, cardId: best.id, similarity: Number(bestSim.toFixed(3)) };
  }

  const type = it.type || classifyByKeyword(text);
  const card = {
    id: nextId('c_'),
    owner_id: owner,
    type,
    summary: text,
    keywords: extractKeywords(text),
    important: it.important != null ? !!it.important : type === 'rule',
    freq: 1,
    created: now(),
    last_used: now(),
    snippet: it.snippet || '',
    origin: it.origin || it.speaker || '',
  };
  cards.push(card);
  facts.push({ id: nextId('f_'), card_id: card.id, fact: text, origin: card.origin, ts: now() });
  saveCards(cards);
  saveFacts(facts);
  return { ok: true, merged: false, cardId: card.id, type };
}

/** 直接新增一张卡片（不走去重） */
function addCard(ownerId, item) {
  const it = item || {};
  const summary = String(it.summary == null ? '' : it.summary).trim();
  if (!summary) return { ok: false, reason: 'empty' };
  const cards = loadCards();
  const card = {
    id: nextId('c_'),
    owner_id: String(ownerId || state.ownerId || 'default'),
    type: it.type || classifyByKeyword(summary),
    summary,
    keywords: extractKeywords(summary),
    important: it.important != null ? !!it.important : (it.type === 'rule'),
    freq: 1,
    created: now(),
    last_used: now(),
    snippet: '',
    origin: it.origin || '',
    weightOverride: typeof it.weightOverride === 'number' ? clamp01(it.weightOverride) : undefined,
  };
  cards.push(card);
  saveCards(cards);
  return { ok: true, cardId: card.id };
}

/** 改卡：summary / type / important / snippet / weightOverride */
function updateCard(id, patch) {
  const p = patch || {};
  const cards = loadCards();
  const c = cards.find((x) => x.id === id);
  if (!c) return { ok: false, reason: 'not-found' };
  if (typeof p.summary === 'string' && p.summary.trim()) {
    c.summary = p.summary.trim();
    c.keywords = extractKeywords(c.summary);
  }
  if (typeof p.type === 'string' && TYPE_LABEL[p.type]) c.type = p.type;
  if (typeof p.important === 'boolean') c.important = p.important;
  if (typeof p.snippet === 'string') c.snippet = p.snippet;
  if (p.weightOverride === null || p.weightOverride === '' || typeof p.weightOverride === 'undefined') {
    delete c.weightOverride;
  } else if (typeof p.weightOverride === 'number' && !Number.isNaN(p.weightOverride)) {
    c.weightOverride = clamp01(p.weightOverride);
  } else if (typeof p.weightOverride === 'string' && p.weightOverride.trim() !== '' && !Number.isNaN(Number(p.weightOverride))) {
    c.weightOverride = clamp01(Number(p.weightOverride));
  }
  c.last_used = now();
  saveCards(cards);
  return { ok: true, card: c };
}

/** 删单张卡（连同它的细节），不牵连其它卡 */
function deleteCard(id) {
  const cards = loadCards();
  const idx = cards.findIndex((x) => x.id === id);
  if (idx < 0) return { ok: false, reason: 'not-found' };
  cards.splice(idx, 1);
  saveCards(cards);
  const facts = loadFacts();
  saveFacts(facts.filter((f) => f.card_id !== id));
  return { ok: true };
}

/** 给某张卡补一条细节 */
function addCardFact(cardId, fact, origin) {
  const text = String(fact == null ? '' : fact).trim();
  if (!text) return { ok: false, reason: 'empty' };
  const cards = loadCards();
  const c = cards.find((x) => x.id === cardId);
  if (!c) return { ok: false, reason: 'not-found' };
  const facts = loadFacts();
  const row = { id: nextId('f_'), card_id: cardId, fact: text, origin: origin || '', ts: now() };
  facts.push(row);
  saveFacts(facts);
  c.freq = (Number(c.freq) || 0) + 1;
  c.last_used = now();
  saveCards(cards);
  return { ok: true, id: row.id, factId: row.id };
}

function deleteCardFact(factId) {
  const facts = loadFacts();
  const idx = facts.findIndex((f) => f.id === factId);
  if (idx < 0) return { ok: false, reason: 'not-found' };
  facts.splice(idx, 1);
  saveFacts(facts);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// 读取 / 检索
// ─────────────────────────────────────────────────────────────

function listCards(ownerId) {
  const cards = loadCards();
  return ownerId ? cards.filter((c) => c.owner_id === ownerId) : cards;
}

function listOwners() {
  const counts = new Map();
  for (const c of loadCards()) {
    const k = c.owner_id || 'default';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count);
}

/** 最近用过的 n 张 */
function getRecentCards(ownerId, n) {
  return listCards(ownerId)
    .slice()
    .sort((a, b) => (Number(b.last_used) || 0) - (Number(a.last_used) || 0))
    .slice(0, n || 5);
}

/** 最新的 n 张（last_used 或 created 更晚者优先） */
function getFreshCards(ownerId, n) {
  return listCards(ownerId)
    .slice()
    .sort((a, b) => {
      const ta = Math.max(Number(a.last_used) || 0, Number(a.created) || 0);
      const tb = Math.max(Number(b.last_used) || 0, Number(b.created) || 0);
      return tb - ta;
    })
    .slice(0, n || 8);
}

function relTime(ts) {
  const diff = now() - (Number(ts) || 0);
  if (!diff || diff < 0) return '刚刚';
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + '分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '小时前';
  const d = Math.floor(h / 24);
  if (d < 30) return d + '天前';
  return Math.floor(d / 30) + '个月前';
}

/** 最新的记忆优先的短上下文（给主动关心 / 主动话题用） */
function buildFreshContext(ownerId, n, maxChars) {
  const cards = getFreshCards(ownerId, n || 8);
  if (!cards.length) return '';
  const lines = cards.map((c) => {
    const ts = Math.max(Number(c.last_used) || 0, Number(c.created) || 0);
    const tag = TYPE_LABEL[c.type] || '日常';
    return '（' + relTime(ts) + '）[' + tag + '] ' + (c.summary || '');
  });
  let out = '【最新记忆 · 越靠上越新，冲突以新为准】\n' + lines.join('\n');
  const cap = maxChars || 900;
  if (out.length > cap) out = out.slice(0, cap) + '…';
  return out;
}

/** 简易相关度打分：关键词命中 + 相似度 */
function scoreCard(card, query, qSig) {
  const kw = Array.isArray(card.keywords) ? card.keywords : [];
  let kwHit = 0;
  for (const k of kw) if (query.includes(k)) kwHit++;
  const sim = qSig ? sigSimilarity(qSig, minhashSignature(card.summary || '')) : similarity(card.summary, query);
  const weight = memoryWeight(card);
  const r = cardRetention(card);
  return sim * 0.55 + Math.min(1, kwHit / 3) * 0.25 + weight * 0.12 + r.retention * 0.08;
}

/** 记忆库检索（替代「把聊天记录塞回去」） */
function searchByQuery(ownerId, query, topN) {
  const q = String(query == null ? '' : query).trim();
  const cards = listCards(ownerId);
  if (!cards.length) return [];
  if (!q) return getRecentCards(ownerId, topN || 10);
  const qSig = minhashSignature(q);
  return cards
    .map((c) => ({ card: c, score: scoreCard(c, q, qSig) }))
    .filter((x) => x.score > 0.06)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN || 10)
    .map((x) => x.card);
}

/** 重排：把「刚才聊到的」也算进来 */
function rerank(query, cards, topN) {
  const q = String(query == null ? '' : query);
  return cards
    .map((c) => ({ c, s: scoreCard(c, q, minhashSignature(q)) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, topN || 3)
    .map((x) => x.c);
}

function factsFor(cardId, facts) {
  const all = facts || loadFacts();
  return all.filter((f) => f.card_id === cardId);
}

/**
 * 三路上下文拼装（喂给 LLM 的 system 片段）
 *   ① 最近 5 张（语气连贯）
 *   ② 检索 Top10（相关）
 *   ③ 重排 Top3（最该被想起来的，附细节）
 * 外加常驻灵魂设定，整体受 budget 字符预算限制。
 */
function buildMemoryContext(ownerId, query, budget) {
  const cap = budget || 2000;
  const cards = listCards(ownerId);
  const soulBlock = soulLines().map((s) => '· ' + s).join('\n');
  // 库还空着也要给灵魂设定：新手刚装上时，智能体不该因为「没有记忆」就变哑巴
  if (!cards.length) {
    return (
      '【记忆库 · 长期记忆】\n' +
      '（记忆库还是空的。之后对话里值得长期记住的事，写进记忆库就行。）\n\n' +
      soulBlock
    );
  }

  const byId = new Map(cards.map((c) => [c.id, c]));
  const parts = [];
  let used = 0;
  const take = (text) => {
    if (!text) return false;
    if (used + text.length > cap) return false;
    parts.push(text);
    used += text.length;
    return true;
  };

  take('【记忆库 · 长期记忆】');

  const recent = getRecentCards(ownerId, 5);
  const recentLines = recent.map((c) => '· [' + (TYPE_LABEL[c.type] || '日常') + '] ' + (c.summary || ''));
  if (recentLines.length) take('【最近想起】\n' + recentLines.join('\n'));

  const hits = searchByQuery(ownerId, query, 10);
  const hitLines = hits
    .filter((c) => !recent.some((r) => r.id === c.id))
    .map((c) => '· [' + (TYPE_LABEL[c.type] || '日常') + '] ' + (c.summary || ''));
  if (hitLines.length) take('【和这次对话相关】\n' + hitLines.join('\n'));

  const top = rerank(query, hits.length ? hits : cards, 3);
  if (top.length) {
    const facts = loadFacts();
    const lines = [];
    for (const c of top) {
      const detail = factsFor(c.id, facts)
        .slice(-3)
        .map((f) => f.fact)
        .filter((x) => x && x !== c.summary);
      lines.push('· [' + (TYPE_LABEL[c.type] || '日常') + '] ' + (c.summary || '') + (detail.length ? '\n  细节：' + detail.join('；') : ''));
    }
    take('【这次最该想起来的】\n' + lines.join('\n'));
  }

  const fresh = getFreshCards(ownerId, 3);
  if (fresh.length) {
    const line = fresh.map((c) => relTime(Math.max(Number(c.last_used) || 0, Number(c.created) || 0)) + '：' + (c.summary || '')).join(' | ');
    take('【最新动态】' + line);
  }

  take(soulBlock);

  if (!parts.length) return '';
  const dropped = byId.size - parts.length;
  return parts.join('\n\n') + (dropped > 0 ? '' : '');
}

// ─────────────────────────────────────────────────────────────
// 关联边（星图用）
// ─────────────────────────────────────────────────────────────

/**
 * 找出卡片之间的关联（共享关键词 或 摘要相似 ≥ 0.3）。
 * @param {Array} cards
 * @param {{ maxEdges?: number, maxDeg?: number }} [opts]
 */
function getRelatedEdges(cards, opts) {
  const o = opts || {};
  const maxEdges = o.maxEdges || 80;
  const maxDeg = o.maxDeg || 4;
  const list = Array.isArray(cards) ? cards : listCards();
  const edges = [];
  const deg = new Map();
  const seen = new Set();

  const bump = (a, b) => {
    const key = a < b ? a + '|' + b : b + '|' + a;
    if (seen.has(key)) return false;
    const da = deg.get(a) || 0;
    const db = deg.get(b) || 0;
    if (da >= maxDeg || db >= maxDeg) return false;
    seen.add(key);
    deg.set(a, da + 1);
    deg.set(b, db + 1);
    return true;
  };

  // ① 共享关键词
  const kwIndex = new Map();
  for (const c of list) {
    const kws = Array.isArray(c.keywords) ? c.keywords : extractKeywords(c.summary || '');
    for (const k of kws) {
      if (!k || k.length < 2) continue;
      if (!kwIndex.has(k)) kwIndex.set(k, []);
      kwIndex.get(k).push(c.id);
    }
  }
  for (const [k, ids] of kwIndex) {
    if (ids.length < 2 || ids.length > 8) continue;
    for (let i = 0; i < ids.length && edges.length < maxEdges; i++) {
      for (let j = i + 1; j < ids.length && edges.length < maxEdges; j++) {
        if (bump(ids[i], ids[j])) edges.push({ a: ids[i], b: ids[j], via: 'keyword:' + k });
      }
    }
  }

  // ② 摘要相似（兜住关键词没撞上的语义近邻）
  const pool = list.slice(0, 220);
  const sigs = new Map(pool.map((c) => [c.id, minhashSignature(c.summary || '')]));
  for (let i = 0; i < pool.length && edges.length < maxEdges; i++) {
    for (let j = i + 1; j < pool.length && edges.length < maxEdges; j++) {
      const a = pool[i];
      const b = pool[j];
      const s = sigSimilarity(sigs.get(a.id), sigs.get(b.id));
      if (s < RELATED_SIM) continue;
      if (bump(a.id, b.id)) edges.push({ a: a.id, b: b.id, via: 'similar', score: Number(s.toFixed(2)) });
    }
  }

  return edges;
}

// ─────────────────────────────────────────────────────────────
// 人物关系图
// ─────────────────────────────────────────────────────────────

function readRelExtra() {
  const p = path.join(dataDir(), STORAGE.relExtra);
  const e = readJson(p, {});
  return {
    renames: e && typeof e.renames === 'object' ? e.renames : {},
    nodeRels: e && typeof e.nodeRels === 'object' ? e.nodeRels : {},
    extraNodes: Array.isArray(e && e.extraNodes) ? e.extraNodes : [],
    extraEdges: Array.isArray(e && e.extraEdges) ? e.extraEdges : [],
    hidden: Array.isArray(e && e.hidden) ? e.hidden : [],
  };
}

function writeRelExtra(e) {
  writeJson(path.join(dataDir(), STORAGE.relExtra), {
    renames: e.renames || {},
    nodeRels: e.nodeRels || {},
    extraNodes: e.extraNodes || [],
    extraEdges: e.extraEdges || [],
    hidden: e.hidden || [],
  });
}

function readMembers() {
  const p = siblingPath(STORAGE.members);
  const v = readJson(p, null);
  if (!v) return null;
  return v;
}

/**
 * 生成关系图数据。优先读宿主写的 members.json（群成员表），
 * 再叠加 relations_extra.json 里用户手工改过的东西。
 */
function getRelations(opts) {
  const o = opts || {};
  const extra = readRelExtra();
  const hidden = new Set(extra.hidden.map(String));
  const renames = extra.renames || {};
  const nodeRels = extra.nodeRels || {};
  const members = readMembers() || {};

  const ownerId = o.ownerId || state.ownerId || '';
  const selfId = o.selfId || process.env.DAYU_SELF_ID || 'self';

  const nodes = [];
  const edges = [];
  const pushNode = (n) => {
    const sid = String(n.id);
    if (hidden.has(sid)) return false;
    if (nodes.some((x) => x.id === sid)) return false;
    nodes.push(n);
    return true;
  };

  const nameOf = (id, dflt) => String(renames[id] || dflt || id);
  const relOf = (id) => {
    const r = nodeRels[String(id)];
    return {
      ownerRel: (r && r.ownerRel) || '同群',
      selfRel: (r && r.selfRel) || '朋友',
    };
  };

  // 主人 / 大肥鱼
  const ownerName = o.ownerName || (ownerId ? nameOf(ownerId, '主人') : '主人');
  const selfName = o.selfName || nameOf(selfId, '大肥鱼');
  pushNode({ id: String(ownerId || 'owner'), name: ownerName, role: 'owner' });
  pushNode({ id: String(selfId), name: selfName, role: 'self' });
  if (ownerId) {
    edges.push({ from: String(ownerId), to: String(selfId), rel: '主人 ↔ 大肥鱼', kind: 'core' });
  }

  // 群成员（兼容三种写法：数组 / {members:[...]} / {uin: name} 映射）
  const groups = members && typeof members === 'object' ? Object.keys(members) : [];
  for (const gid of groups) {
    const g = members[gid];
    let list = [];
    if (Array.isArray(g)) {
      list = g;
    } else if (Array.isArray(g && g.members)) {
      list = g.members;
    } else if (g && typeof g === 'object') {
      list = Object.keys(g).map((k) => {
        const v = g[k];
        if (typeof v === 'string') return { uin: k, name: v };
        if (v && typeof v === 'object') return { uin: k, name: v.name || v.card || v.nickname || k };
        return { uin: k, name: k };
      });
    }
    const gName = (g && g.name) || gid;
    for (const m of list) {
      if (!m) continue;
      const mid = String(m.uin || m.id || m.user_id || '');
      if (!mid) continue;
      if (mid === String(ownerId)) continue;
      const nm = nameOf(mid, m.name || m.nickname || m.card || mid);
      if (pushNode({ id: mid, name: nm, role: 'friend', group: gName, ...relOf(mid) })) {
        const r = relOf(mid);
        edges.push({ from: String(ownerId || 'owner'), to: mid, rel: r.ownerRel, kind: 'owner' });
        edges.push({ from: String(selfId), to: mid, rel: r.selfRel, kind: 'self' });
      }
    }
  }

  // 手工节点
  for (const n of extra.extraNodes) {
    if (!n || !n.id) continue;
    if (pushNode({ id: String(n.id), name: nameOf(n.id, n.name), role: n.role || 'friend', ...relOf(n.id) })) {
      const r = relOf(n.id);
      edges.push({ from: String(ownerId || 'owner'), to: String(n.id), rel: r.ownerRel, kind: 'owner' });
      edges.push({ from: String(selfId), to: String(n.id), rel: r.selfRel, kind: 'self' });
    }
  }

  // 手工连线
  for (const e of extra.extraEdges) {
    if (!e || !e.from || !e.to) continue;
    if (!nodes.some((n) => n.id === String(e.from)) || !nodes.some((n) => n.id === String(e.to))) continue;
    edges.push({ from: String(e.from), to: String(e.to), rel: e.rel || '认识', kind: 'custom', custom: true });
  }

  // 去重边
  const seen = new Set();
  const edgesOut = [];
  for (const e of edges) {
    const k = [e.from, e.to].sort().join('|') + '|' + (e.rel || '');
    if (seen.has(k)) continue;
    seen.add(k);
    edgesOut.push(e);
  }

  return {
    nodes,
    edges: edgesOut,
    ownerId: String(ownerId || 'owner'),
    selfId: String(selfId),
    ownerProfile: readJson(siblingPath(STORAGE.ownerProfile), null),
    selfProfile: readJson(siblingPath(STORAGE.selfProfile), null),
  };
}

function setRelationRels(id, ownerRel, selfRel) {
  const extra = readRelExtra();
  const sid = String(id);
  extra.nodeRels[sid] = {
    ownerRel: String(ownerRel || '').trim().slice(0, 20) || '同群',
    selfRel: String(selfRel || '').trim().slice(0, 20) || '朋友',
  };
  writeRelExtra(extra);
  return { ok: true };
}

function renameRelation(id, name) {
  const extra = readRelExtra();
  const sid = String(id);
  const nm = String(name || '').trim().slice(0, 40);
  if (!nm) return { ok: false, reason: 'empty' };
  extra.renames[sid] = nm;
  // 顺手改进 members.json 里的名字（若存在）
  const members = readMembers();
  if (members) {
    let touched = false;
    for (const gid of Object.keys(members)) {
      const g = members[gid];
      const list = Array.isArray(g) ? g : Array.isArray(g && g.members) ? g.members : null;
      if (!list) continue;
      for (const m of list) {
        if (!m) continue;
        const mid = String(m.uin || m.id || m.user_id || '');
        if (mid && mid === sid) {
          m.name = nm;
          touched = true;
        }
      }
    }
    if (touched) writeJson(siblingPath(STORAGE.members), members);
  }
  writeRelExtra(extra);
  return { ok: true };
}

function addRelationNode(name, role) {
  const nm = String(name || '').trim().slice(0, 40);
  if (!nm) return { ok: false, reason: 'empty' };
  const extra = readRelExtra();
  const id = 'n' + now().toString(36) + Math.random().toString(36).slice(2, 6);
  extra.extraNodes.push({ id, name: nm, role: role || 'friend' });
  writeRelExtra(extra);
  return { ok: true, id };
}

function deleteRelationNode(id, opts) {
  const sid = String(id == null ? '' : id);
  const o = opts || {};
  if (!sid) return { ok: false, reason: 'invalid' };
  const guardOwner = String(o.ownerId || state.ownerId || '');
  const guardSelf = String(o.selfId || process.env.DAYU_SELF_ID || '');
  if (guardOwner && sid === guardOwner) return { ok: false, reason: 'protected', message: '主人不能被移除' };
  if (guardSelf && sid === guardSelf) return { ok: false, reason: 'protected', message: '大肥鱼自己不能被移除' };
  const extra = readRelExtra();
  const had = extra.extraNodes.some((n) => String(n && n.id) === sid);
  if (!extra.hidden.includes(sid)) extra.hidden.push(sid);
  extra.extraNodes = extra.extraNodes.filter((n) => String(n && n.id) !== sid);
  delete extra.nodeRels[sid];
  writeRelExtra(extra);
  return { ok: true, removed: had || true };
}

function addRelationEdge(from, to, rel) {
  const a = String(from || '');
  const b = String(to || '');
  if (!a || !b || a === b) return { ok: false, reason: 'invalid' };
  const extra = readRelExtra();
  const dup = extra.extraEdges.some((e) => [e.from, e.to].sort().join('|') === [a, b].sort().join('|'));
  if (dup) return { ok: false, reason: 'exists' };
  extra.extraEdges.push({ from: a, to: b, rel: String(rel || '认识').trim().slice(0, 20) || '认识' });
  writeRelExtra(extra);
  return { ok: true };
}

function deleteRelationEdge(from, to) {
  const a = String(from || '');
  const b = String(to || '');
  const extra = readRelExtra();
  const before = extra.extraEdges.length;
  extra.extraEdges = extra.extraEdges.filter((e) => [e.from, e.to].sort().join('|') !== [a, b].sort().join('|'));
  writeRelExtra(extra);
  return { ok: true, removed: before - extra.extraEdges.length };
}

// ─────────────────────────────────────────────────────────────
// 上下文用量（读宿主写的统计文件，缺失则自查 JSONL）
// ─────────────────────────────────────────────────────────────

function getContextUsage() {
  const p = siblingPath(STORAGE.usage);
  const v = readJson(p, null);
  if (!v || typeof v !== 'object') {
    return { available: false, path: p, windowTokens: 131072 };
  }
  const windowTokens = Number(v.windowTokens) || 131072;
  const lastPromptTokens = Number(v.lastPromptTokens) || 0;
  const totalPrompt = Number(v.totalPromptTokens) || 0;
  const totalCompletion = Number(v.totalCompletionTokens) || 0;
  const totalAll = totalPrompt + totalCompletion;
  return {
    available: true,
    path: p,
    updated: Number(v.updated) || 0,
    totalCalls: Number(v.totalCalls) || 0,
    windowTokens,
    lastPromptTokens,
    lastCompletionTokens: Number(v.lastCompletionTokens) || 0,
    usedPct: Number(((lastPromptTokens / windowTokens) * 100).toFixed(1)),
    remainTokens: Math.max(0, windowTokens - lastPromptTokens),
    totalPromptTokens: totalPrompt,
    totalCompletionTokens: totalCompletion,
    totalAll,
    totalMult: Number((totalAll / windowTokens).toFixed(1)),
    perSession: v.perSession || {},
  };
}

// ─────────────────────────────────────────────────────────────
// LLM 提炼（本模块不联网：把 prompt 给出去，宿主自己调模型）
// ─────────────────────────────────────────────────────────────

const EXTRACTION_SCHEMA = `{"facts":[{"type":"rule|preference|goal|emotion|fact","text":"一句话，第三人称，不要加引号"}]}`;

/**
 * 生成「从一轮对话里提炼记忆」的提示词。
 * @param {{userText:string, aiReply?:string, speaker?:string}} input
 */
function buildExtractionPrompt(input) {
  const it = input || {};
  const who = String(it.speaker || '主人').trim() || '主人';
  const userText = String(it.userText || '').trim();
  const aiReply = String(it.aiReply || '').trim();
  return [
    '你是一个记忆提炼器。从下面这段对话中，只提炼值得长期记住的信息。',
    '',
    '规则：',
    '1. 只提炼与「' + who + '」本人相关的、可复用的信息：身份、称呼、喜好厌恶、习惯、重要经历、明确的要求或禁忌、情绪的重要来源、正在做的事与目标。',
    '2. 不要提炼：寒暄、天气、一次性的临时安排、笑话、没有信息量的回应、纯情绪语气词。',
    '3. 每条记忆用第三人称、一句话、不超过 40 个字，主语必须是「' + who + '」，不允许写成别的称呼。',
    '4. type 只能是 rule / preference / goal / emotion / fact 之一。',
    '   rule=明确要求或禁忌；preference=喜好厌恶习惯；goal=正在做或想做的事；emotion=重要的情绪与情感关系；fact=其它稳定事实。',
    '5. 宁可少也不要编。没有值得记的内容就返回 {"facts":[]}。',
    '',
    '对话：',
    '[' + who + '] ' + userText,
    aiReply ? '[你] ' + aiReply : '',
    '',
    '只输出 JSON，格式：' + EXTRACTION_SCHEMA,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 从模型返回里抠出 JSON（容忍前后废话与 ```json 包裹） */
function parseExtraction(raw) {
  const text = String(raw == null ? '' : raw);
  if (!text.trim()) return [];
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let obj;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return [];
  }
  const list = Array.isArray(obj && obj.facts) ? obj.facts : [];
  const allowed = new Set(Object.keys(TYPE_LABEL));
  const out = [];
  for (const f of list) {
    if (!f) continue;
    const t = String(f.text == null ? '' : f.text).trim();
    if (!t || t.length < 2 || t.length > 120) continue;
    const type = allowed.has(f.type) ? f.type : classifyByKeyword(t);
    out.push({ type, text: t });
  }
  return out;
}

/**
 * 端到端提炼：先问「这轮值不值得记」，再调模型，最后落库。
 * @param {{userText:string, aiReply?:string, speaker?:string}} input
 * @param {(prompt:string)=>Promise<string>} callLLM 宿主提供的补全函数
 * @param {{ownerId?:string, force?:boolean}} [opts]
 */
async function extractMemory(input, callLLM, opts) {
  const o = opts || {};
  const it = input || {};
  const userText = String(it.userText || '').trim();
  if (!userText) return { ok: false, reason: 'empty', added: [] };
  if (!o.force && !shouldExtract(userText)) return { ok: true, skipped: true, added: [] };
  if (typeof callLLM !== 'function') return { ok: false, reason: 'no-llm', added: [] };

  const prompt = buildExtractionPrompt(it);
  let raw = '';
  try {
    raw = await callLLM(prompt);
  } catch (err) {
    return { ok: false, reason: 'llm-error:' + ((err && err.message) || err), added: [] };
  }
  const facts = parseExtraction(raw);
  const added = [];
  for (const f of facts) {
    const r = addFact(o.ownerId, { text: f.text, type: f.type, speaker: it.speaker || '' });
    if (r && r.ok) added.push(f);
  }
  return { ok: true, added, raw };
}

/** 廉价的前置闸门：这些话不值得花 Token 去提炼 */
function shouldExtract(text) {
  const t = String(text == null ? '' : text).trim();
  if (t.length < 6) return false;
  if (/^(哈+|嘿+|嗯+|哦+|好+|在吗|在不在|早安|晚安|早|睡了|拜拜|886|收到|ok|OK|1|。|？)+$/.test(t)) return false;
  if (/^\[CQ:/.test(t)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────

function stats(ownerId) {
  const cards = listCards(ownerId);
  const facts = loadFacts();
  const cardIds = new Set(cards.map((c) => c.id));
  const t = now();
  let fading = 0;
  let important = 0;
  const byType = {};
  for (const c of cards) {
    const r = cardRetention(c, t);
    if (r.forgetting && !r.protected) fading++;
    if (c.important) important++;
    byType[c.type || 'fact'] = (byType[c.type || 'fact'] || 0) + 1;
  }
  return {
    dataDir: dataDir(),
    resolvedBy: state.resolvedBy,
    cardsPath: cardsPath(),
    factsPath: factsPath(),
    cards: cards.length,
    facts: facts.filter((f) => cardIds.has(f.card_id)).length,
    owners: listOwners(),
    important,
    fading,
    byType,
    mergeSim: MERGE_SIM,
    ebbinghaus: {
      sDay: EBBINGHAUS_S_DAY,
      forgetR: EBBINGHAUS_FORGET_R,
      forgetFreq: EBBINGHAUS_FORGET_FREQ,
      typeBaseWeight: TYPE_BASE_WEIGHT,
    },
    typeLabels: TYPE_LABEL,
  };
}

module.exports = {
  // 配置与路径
  configure,
  resolveDataDir,
  dataDir,
  siblingPath,
  // 存储
  loadCards,
  saveCards,
  loadFacts,
  saveFacts,
  // 相似度
  normalize,
  shingles,
  jaccard,
  similarity,
  minhashSignature,
  sigSimilarity,
  // 分类
  classifyByKeyword,
  extractKeywords,
  TYPE_KEYWORDS,
  TYPE_LABEL,
  TYPE_BASE_WEIGHT,
  // 权重 / 遗忘
  EBBINGHAUS_S_DAY,
  EBBINGHAUS_FORGET_R,
  EBBINGHAUS_FORGET_FREQ,
  MERGE_SIM,
  RELATED_SIM,
  memoryWeight,
  cardRetention,
  retentionReport,
  sweepMemory,
  // 写入
  addFact,
  addCard,
  updateCard,
  deleteCard,
  addCardFact,
  deleteCardFact,
  // 读取 / 检索
  listCards,
  listOwners,
  getRecentCards,
  getFreshCards,
  buildFreshContext,
  searchByQuery,
  rerank,
  buildMemoryContext,
  getRelatedEdges,
  // 关系图
  getRelations,
  readRelExtra,
  writeRelExtra,
  renameRelation,
  addRelationNode,
  deleteRelationNode,
  addRelationEdge,
  deleteRelationEdge,
  setRelationRels,
  // 上下文用量
  getContextUsage,
  // 提炼
  buildExtractionPrompt,
  parseExtraction,
  extractMemory,
  shouldExtract,
  // 其它
  relTime,
  stats,
  SOUL,
  soulLines,
  parseSoul,
  STORAGE,
};
