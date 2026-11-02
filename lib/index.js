'use strict';
/**
 * dsh-dayu-memory-star / host 半侧
 * ---------------------------------------------------------------
 * 这一半跑在 DSH 宿主进程里，做三件事：
 *   1. 把记忆库（JSON 文件）读出来，通过同源 HTTP 路由交给浏览器半侧；
 *   2. 往 Web 首屏 HTML 里注入一段脚本，挂上「记忆星图」面板；
 *   3. 给智能体注册两个工具（检索记忆 / 写入记忆），让对话能直接用记忆库。
 *
 * 它不依赖任何第三方包，没有构建步骤，安装时不会触发任何 install/prepare 脚本。
 */

const fs = require('node:fs');
const path = require('node:path');
const core = require('./memory-core.js');

const ROUTE_BASE = '/dayu-memory-star';
const ROUTE_API = ROUTE_BASE + '/api';
const ROUTE_CLIENT = ROUTE_BASE + '/client.js';
const ROUTE_ICON = ROUTE_BASE + '/icon.svg';
const INJECT_MARK = 'data-dayu-memory-star';

const PKG_DIR = path.dirname(__dirname);

function pkgFile(rel) {
  return path.join(PKG_DIR, rel);
}

function readPkg(rel) {
  try {
    return fs.readFileSync(pkgFile(rel), 'utf8');
  } catch {
    return '';
  }
}

function sendJson(res, payload, status) {
  const body = JSON.stringify(payload);
  res.writeHead(status || 200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, text, type) {
  res.writeHead(200, {
    'content-type': type || 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req, limit) {
  const cap = limit || 1024 * 512;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────

function readConfig(ctx2, raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const env = process.env;
  return {
    // dataDir 只认配置项；环境变量交给 memory-core 自己认，这样「状态」页能如实显示识别方式
    dataDir: c.dataDir || '',
    ownerId: c.ownerId || env.DAYU_OWNER_ID || '',
    ownerName: c.ownerName || env.DAYU_OWNER_NAME || '',
    selfId: c.selfId || env.DAYU_SELF_ID || '',
    selfName: c.selfName || env.DAYU_SELF_NAME || '',
    soul: c.soul || env.DAYU_SOUL || '',
    bridgeUrl: c.bridgeUrl || env.DAYU_BRIDGE_URL || '',
    bridgeToken: c.bridgeToken || env.DAYU_BRIDGE_TOKEN || '',
    showLauncher: c.showLauncher !== false,
  };
}

// ─────────────────────────────────────────────────────────────
// 数据组装
// ─────────────────────────────────────────────────────────────

function cardsWithMeta(ownerId) {
  const cards = core.listCards(ownerId || undefined);
  const facts = core.loadFacts();
  const byCard = new Map();
  for (const f of facts) {
    if (!byCard.has(f.card_id)) byCard.set(f.card_id, []);
    byCard.get(f.card_id).push(f);
  }
  const t = Date.now();
  return cards.map((c) => {
    const r = core.cardRetention(c, t);
    const detail = (byCard.get(c.id) || []).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return {
      id: c.id,
      owner_id: c.owner_id,
      type: c.type || 'fact',
      summary: c.summary || '',
      name: cardName(c),
      keywords: Array.isArray(c.keywords) ? c.keywords : [],
      important: !!c.important,
      freq: Number(c.freq) || 0,
      created: Number(c.created) || 0,
      last_used: Number(c.last_used) || 0,
      snippet: c.snippet || '',
      weightOverride: typeof c.weightOverride === 'number' ? c.weightOverride : null,
      weight: r.weight,
      retention: r.retention,
      stabilityDays: r.stabilityDays,
      ageDays: r.ageDays,
      protected: r.protected,
      facts: detail.map((f) => ({ id: f.id, fact: f.fact, origin: f.origin || '', ts: f.ts || 0 })),
    };
  });
}

/** 卡片名：摘要前 10 字，去掉尾部标点 */
function cardName(c) {
  const s = String((c && c.summary) || '').trim().replace(/\s+/g, ' ');
  if (!s) return '未命名记忆';
  let name = s.slice(0, 10).replace(/[，。！？、；：,.!?;:…]+$/, '');
  if (!name) name = s.slice(0, 10);
  return s.length > name.length ? name + '…' : name;
}

function allData(cfg) {
  const cards = cardsWithMeta(cfg.ownerId);
  return {
    ok: true,
    stats: core.stats(cfg.ownerId),
    cards,
    relatedEdges: core.getRelatedEdges(cards, { maxEdges: 80, maxDeg: 4 }),
    relations: core.getRelations({ ownerId: cfg.ownerId, selfId: cfg.selfId, ownerName: cfg.ownerName, selfName: cfg.selfName }),
    context: core.getContextUsage(),
    retention: core.retentionReport(cfg.ownerId),
    config: { showLauncher: cfg.showLauncher, hasBridge: !!cfg.bridgeUrl },
  };
}

async function bridgeStatus(cfg) {
  if (!cfg.bridgeUrl) return { available: false };
  const url = cfg.bridgeUrl.replace(/\/+$/, '') + '/get_login_info';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 900);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: Object.assign(
        { 'content-type': 'application/json' },
        cfg.bridgeToken ? { authorization: 'Bearer ' + cfg.bridgeToken } : {}
      ),
      body: '{}',
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    const data = (json && json.data) || {};
    return {
      available: true,
      online: res.ok,
      nickname: data.nickname || '',
      uin: String(data.user_id || data.uin || ''),
    };
  } catch (err) {
    return { available: true, online: false, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────
// 路由
// ─────────────────────────────────────────────────────────────

function makeApiHandler(getCfg) {
  return async function apiHandler(req, res) {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      pathname = req.url || '/';
    }
    const suffix = pathname.slice(ROUTE_API.length).replace(/\/+$/, '') || '/';
    const cfg = getCfg();
    const method = (req.method || 'GET').toUpperCase();

    try {
      if (method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*' });
        res.end();
        return;
      }

      if (method === 'GET' || method === 'HEAD') {
        if (suffix === '/all' || suffix === '/') {
          sendJson(res, allData(cfg));
          return;
        }
        if (suffix === '/status') {
          sendJson(res, {
            ok: true,
            stats: core.stats(cfg.ownerId),
            context: core.getContextUsage(),
            bridge: await bridgeStatus(cfg),
            retention: core.retentionReport(cfg.ownerId),
          });
          return;
        }
        if (suffix === '/context') {
          const u = new URL(req.url, 'http://127.0.0.1');
          const q = u.searchParams.get('q') || '';
          const budget = Number(u.searchParams.get('budget')) || 2000;
          sendJson(res, { ok: true, text: core.buildMemoryContext(cfg.ownerId, q, budget) });
          return;
        }
        sendJson(res, { ok: false, error: 'not found' }, 404);
        return;
      }

      if (method !== 'POST') {
        sendJson(res, { ok: false, error: 'method not allowed' }, 405);
        return;
      }

      const body = await readBody(req);

      switch (suffix) {
        case '/card/update':
          sendJson(res, core.updateCard(String(body.id || ''), body.patch || {}));
          return;
        case '/card/delete':
          sendJson(res, core.deleteCard(String(body.id || '')));
          return;
        case '/card/add':
          sendJson(res, core.addCard(cfg.ownerId, body.item || body));
          return;
        case '/fact/add':
          sendJson(res, core.addCardFact(String(body.cardId || ''), body.fact, body.origin));
          return;
        case '/fact/delete':
          sendJson(res, core.deleteCardFact(String(body.factId || '')));
          return;
        case '/remember':
          sendJson(res, core.addFact(cfg.ownerId, body));
          return;
        case '/search': {
          const list = core.searchByQuery(cfg.ownerId, String(body.query || ''), Number(body.topN) || 8);
          sendJson(res, { ok: true, cards: list.map((c) => ({ id: c.id, type: c.type, summary: c.summary })) });
          return;
        }
        case '/sweep':
          sendJson(res, Object.assign({ ok: true }, core.sweepMemory(Date.now(), { dryRun: !!body.dryRun })));
          return;
        case '/relations/rename':
          sendJson(res, core.renameRelation(String(body.id || ''), body.name));
          return;
        case '/relations/addNode':
          sendJson(res, core.addRelationNode(body.name, body.role));
          return;
        case '/relations/deleteNode':
          sendJson(res, core.deleteRelationNode(String(body.id || ''), { ownerId: cfg.ownerId, selfId: cfg.selfId }));
          return;
        case '/relations/addEdge':
          sendJson(res, core.addRelationEdge(body.from, body.to, body.rel));
          return;
        case '/relations/deleteEdge':
          sendJson(res, core.deleteRelationEdge(body.from, body.to));
          return;
        case '/relations/setRels':
          sendJson(res, core.setRelationRels(String(body.id || ''), body.ownerRel, body.selfRel));
          return;
        default:
          sendJson(res, { ok: false, error: 'unknown endpoint: ' + suffix }, 404);
      }
    } catch (err) {
      sendJson(res, { ok: false, error: String((err && err.message) || err) }, 500);
    }
  };
}

function clientHandler(req, res) {
  const js = readPkg('lib/client.js');
  if (!js) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('client.js missing');
    return;
  }
  sendText(res, js, 'text/javascript; charset=utf-8');
}

function iconHandler(req, res) {
  const svg = readPkg('icon.svg');
  if (!svg) {
    res.writeHead(404);
    res.end();
    return;
  }
  sendText(res, svg, 'image/svg+xml; charset=utf-8');
}

function injectClient(html, cfg) {
  if (typeof html !== 'string') return html;
  if (html.indexOf(INJECT_MARK) !== -1) return html;
  const boot = {
    api: ROUTE_API,
    showLauncher: cfg.showLauncher !== false,
    version: 1,
  };
  const snippet =
    '\n<script ' +
    INJECT_MARK +
    '>window.__DAYU_MEMORY_STAR__=' +
    JSON.stringify(boot) +
    ';</script>\n<script src="' +
    ROUTE_CLIENT +
    '" defer></script>\n';
  if (html.indexOf('</body>') !== -1) return html.replace('</body>', snippet + '</body>');
  return html + snippet;
}

/**
 * 独立页面：http://127.0.0.1:<port>/dayu-memory-star
 * 万一宿主版本太老、没有 tapIndex（注入不进首屏），用户仍然能从这里打开星图。
 */
function pageHandler(req, res) {
  const boot = { api: ROUTE_API, showLauncher: false, version: 1 };
  const html =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>大肥鱼记忆星图</title>' +
    '<style>html,body{margin:0;height:100%;background:#000008;color:#dfe6ff;' +
    'font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif}#boot{position:fixed;inset:0;display:flex;' +
    'align-items:center;justify-content:center;letter-spacing:.08em;color:#8fa0c8}</style></head><body>' +
    '<div id="boot">正在铺开星空…</div>' +
    '<script ' +
    INJECT_MARK +
    '>window.__DAYU_MEMORY_STAR__=' +
    JSON.stringify(boot) +
    ';</script>' +
    '<script src="' +
    ROUTE_CLIENT +
    '" defer></script>' +
    '<script>window.addEventListener("load",function(){setTimeout(function(){' +
    'try{if(window.__dayuMemoryStarOpen)window.__dayuMemoryStarOpen()}catch(e){}},400)});</script>' +
    '</body></html>';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

// ─────────────────────────────────────────────────────────────
// 智能体工具
// ─────────────────────────────────────────────────────────────

function registerTools(registry, cfg) {
  if (!registry || typeof registry.register !== 'function') return [];

  const offs = [];

  offs.push(
    registry.register({
      name: 'dayu_memory_search',
      description:
        '在长期记忆库中检索。回答「主人喜欢什么 / 我们之前说过什么 / 他现在在做什么」这类涉及长期记忆的问题时，先用它检索，不要凭聊天记录猜。返回按相关度排序的记忆条目。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要检索的内容或问题，中文自然语句即可' },
          top_n: { type: 'number', description: '返回条数，默认 6' },
        },
        required: ['query'],
      },
      async execute(args) {
        const list = core.searchByQuery(cfg.ownerId, String((args && args.query) || ''), Number(args && args.top_n) || 6);
        if (!list.length) return { content: [{ type: 'text', text: '记忆库里没有相关条目。' }] };
        const lines = list.map((c, i) => {
          const r = core.cardRetention(c);
          return (
            i +
            1 +
            '. [' +
            (core.TYPE_LABEL[c.type] || '日常') +
            '] ' +
            (c.summary || '') +
            '（' +
            core.relTime(Math.max(Number(c.last_used) || 0, Number(c.created) || 0)) +
            '，保留率 ' +
            Math.round(r.retention * 100) +
            '%）'
          );
        });
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      },
    })
  );

  offs.push(
    registry.register({
      name: 'dayu_memory_remember',
      description:
        '把一条值得长期记住的信息写进记忆库。只写稳定、可复用的信息（身份、喜好、习惯、明确的要求或禁忌、正在做的事）。不要写寒暄和一次性的临时安排。相似度 ≥0.85 时会自动并入已有记忆。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '一句话，第三人称，不超过 40 字，主语写清楚是谁' },
          type: {
            type: 'string',
            enum: ['rule', 'preference', 'goal', 'emotion', 'fact'],
            description: 'rule=要求或禁忌 preference=喜好厌恶 goal=目标情绪外的计划 emotion=重要情绪 fact=其它事实',
          },
          important: { type: 'boolean', description: '是否永不遗忘（规则类建议 true）' },
        },
        required: ['text'],
      },
      async execute(args) {
        const r = core.addFact(cfg.ownerId, {
          text: String((args && args.text) || ''),
          type: args && args.type,
          important: args && args.important,
          origin: 'agent',
        });
        const text = r && r.ok ? (r.merged ? '已并入已有记忆。' : '已记下（' + (core.TYPE_LABEL[r.type] || '日常') + '）。') : '没写进去：' + ((r && r.reason) || 'unknown');
        return { content: [{ type: 'text', text }] };
      },
    })
  );

  return offs;
}

// ─────────────────────────────────────────────────────────────
// 插件入口
// ─────────────────────────────────────────────────────────────

const plugin = {
  name: 'dsh-dayu-memory-star',

  inject: ['webServer'],

  apply(ctx, config) {
    const cfg = readConfig(ctx, config);
    core.configure({ dataDir: cfg.dataDir, ownerId: cfg.ownerId, soul: cfg.soul });

    // ② 记忆库 HTTP 路由 + 首屏脚本注入
    ctx.effect(() => {
      const ws = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer;
      if (!ws) return undefined;
      const offs = [];
      const dispose = (fn) => {
        if (typeof fn === 'function') offs.push(fn);
      };
      dispose(ws.register({ kind: 'prefix', path: ROUTE_API, handler: makeApiHandler(() => cfg) }));
      dispose(ws.register({ kind: 'exact', path: ROUTE_CLIENT, handler: clientHandler }));
      dispose(ws.register({ kind: 'exact', path: ROUTE_ICON, handler: iconHandler }));
      // 独立页面兜底：宿主没有 tapIndex 时也能直接从地址栏打开
      dispose(ws.register({ kind: 'exact', path: ROUTE_BASE, handler: pageHandler }));
      if (typeof ws.tapIndex === 'function') {
        dispose(ws.tapIndex((html) => injectClient(html, cfg)));
      }
      return () => {
        for (const off of offs) {
          try {
            off();
          } catch {
            /* 卸载时的清理失败不该影响宿主 */
          }
        }
      };
    }, 'dsh-dayu-memory-star: memory api + star-map panel');

    // ③ 智能体工具
    ctx.effect(() => {
      const dispose = (fn) => fn;
      const direct = ctx.tools;
      if (direct && typeof direct.register === 'function') {
        const offs = registerTools(direct, cfg);
        return () => {
          for (const off of offs) {
            try {
              if (typeof off === 'function') off();
              else if (off && typeof off.dispose === 'function') off.dispose();
            } catch {
              /* ignore */
            }
          }
        };
      }
      if (typeof ctx.inject === 'function') {
        ctx.inject(['tools'], (sub) => {
          if (!sub || !sub.tools) return;
          try {
            registerTools(sub.tools, cfg);
          } catch {
            /* 工具注册失败不影响面板 */
          }
        });
      }
      return dispose(undefined);
    }, 'dsh-dayu-memory-star: memory tools');
  },
};

module.exports = plugin;
