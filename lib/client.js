/* eslint-disable */
/**
 * dsh-dayu-memory-star / 浏览器半侧
 * ---------------------------------------------------------------
 * 由宿主往首屏 HTML 里注入的一段脚本（不加 iframe、不用 React、不加载任何第三方库）。
 * 它做两件事：
 *   1. 在右下角挂一个入口按钮；
 *   2. 打开一个全屏面板：3D 星图 + 人物关系图 + 上下文用量 + 运行状态，全部可读可改。
 *
 * 数据全部走同源 `/dayu-memory-star/api/*`，不碰宿主的内部模块。
 */
(function () {
  'use strict';

  if (window.__DAYU_MEMORY_STAR_LOADED__) return;
  window.__DAYU_MEMORY_STAR_LOADED__ = true;

  var BOOT = window.__DAYU_MEMORY_STAR__ || {};
  var API = BOOT.api || '/dayu-memory-star/api';

  var TYPE_COLORS = {
    rule: '#ffd27f',
    preference: '#7ee0ff',
    goal: '#a78bfa',
    emotion: '#ff8fb1',
    fact: '#cfd8ea',
  };
  var TYPE_LABELS = {
    rule: '规则',
    preference: '偏好',
    goal: '目标',
    emotion: '情感',
    fact: '日常',
  };
  var TYPE_ORDER = ['rule', 'preference', 'goal', 'emotion', 'fact'];
  var SESSION_LABELS = {
    vision: '识图',
    care: '主动关心',
    spont: '主动话题',
    share: '视频分享',
    douyin_owner: '抖音·主人',
    owner_profile: '主人画像',
    self_profile: '自我画像',
    unknown: '未知',
  };

  // ───────────────────────────────────────────────────────────
  // 小工具
  // ───────────────────────────────────────────────────────────

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function $(id) {
    return document.getElementById(id);
  }
  function esc(s) {
    return String(s == null ? '' : s);
  }
  function isObj(v) {
    return v && typeof v === 'object';
  }
  function hexToRgb(hex) {
    var h = String(hex || '#ffffff').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }

  // 预渲染精灵：每帧只 drawImage，避免在动画循环里反复造 gradient
  var SPR = {};
  function makeSprite(key, size, paint) {
    var hit = SPR[key];
    if (hit) return hit;
    var cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    paint(cv.getContext('2d'), size);
    SPR[key] = cv;
    return cv;
  }
  function blobSprite(color) {
    return makeSprite('blob:' + color, 128, function (c2, s) {
      var g = c2.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, rgba(color, 0.95));
      g.addColorStop(0.38, rgba(color, 0.38));
      g.addColorStop(0.7, rgba(color, 0.1));
      g.addColorStop(1, rgba(color, 0));
      c2.fillStyle = g;
      c2.fillRect(0, 0, s, s);
    });
  }
  function raySprite(color) {
    return makeSprite('ray:' + color, 256, function (c2, s) {
      var c = s / 2;
      c2.globalCompositeOperation = 'lighter';
      var i;
      for (i = 0; i < 16; i++) {
        var a = (i / 16) * Math.PI * 2;
        var l = c * 0.98;
        var g = c2.createLinearGradient(c, c, c + Math.cos(a) * l, c + Math.sin(a) * l);
        g.addColorStop(0, rgba(color, 0.72));
        g.addColorStop(1, rgba(color, 0));
        c2.strokeStyle = g;
        c2.lineWidth = 1.8;
        c2.beginPath();
        c2.moveTo(c, c);
        c2.lineTo(c + Math.cos(a) * l, c + Math.sin(a) * l);
        c2.stroke();
      }
      for (i = 0; i < 16; i++) {
        var a2 = ((i + 0.5) / 16) * Math.PI * 2;
        var l2 = c * 0.34;
        var g2 = c2.createLinearGradient(c, c, c + Math.cos(a2) * l2, c + Math.sin(a2) * l2);
        g2.addColorStop(0, rgba(color, 0.55));
        g2.addColorStop(1, rgba(color, 0));
        c2.strokeStyle = g2;
        c2.lineWidth = 1.4;
        c2.beginPath();
        c2.moveTo(c, c);
        c2.lineTo(c + Math.cos(a2) * l2, c + Math.sin(a2) * l2);
        c2.stroke();
      }
    });
  }
  function coreSprite(color) {
    return makeSprite('core:' + color, 64, function (c2, s) {
      var c = s / 2;
      var g = c2.createRadialGradient(c * 0.82, c * 0.82, 0, c, c, c);
      g.addColorStop(0, 'rgba(255,255,255,0.96)');
      g.addColorStop(0.34, rgba(color, 0.9));
      g.addColorStop(1, rgba(color, 0));
      c2.fillStyle = g;
      c2.beginPath();
      c2.arc(c, c, c, 0, Math.PI * 2);
      c2.fill();
    });
  }
  function drawSprite(sprite, x, y, r) {
    if (r < 0.4) return;
    ctx2d.drawImage(sprite, x - r, y - r, r * 2, r * 2);
  }
  function relTime(ts) {
    var t = Number(ts) || 0;
    if (!t) return '未知';
    var diff = Date.now() - t;
    if (diff < 60000) return '刚刚';
    var m = Math.floor(diff / 60000);
    if (m < 60) return m + '分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + '小时前';
    var d = Math.floor(h / 24);
    if (d < 30) return d + '天前';
    return Math.floor(d / 30) + '个月前';
  }
  function fmtNum(n) {
    var v = Number(n) || 0;
    if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
    return String(v);
  }

  // ───────────────────────────────────────────────────────────
  // 样式
  // ───────────────────────────────────────────────────────────

  var CSS = [
    '.dms-launcher{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;align-items:center;gap:8px;',
    'padding:9px 14px;border-radius:999px;cursor:pointer;font:600 13px/1 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
    'color:#ffe9b0;background:radial-gradient(circle at 30% 25%,rgba(120,90,220,.95),rgba(24,18,52,.96) 70%);',
    'border:1px solid rgba(255,210,127,.45);box-shadow:0 8px 28px rgba(20,10,50,.55),0 0 0 1px rgba(0,0,0,.2) inset;',
    'backdrop-filter:blur(6px);transition:transform .15s ease,box-shadow .15s ease;user-select:none}',
    '.dms-launcher:hover{transform:translateY(-2px);box-shadow:0 12px 34px rgba(30,14,70,.7)}',
    '.dms-launcher .dms-dot{width:9px;height:9px;border-radius:50%;background:#ffd27f;box-shadow:0 0 10px 3px rgba(255,210,127,.75)}',
    '.dms-overlay{position:fixed;inset:0;z-index:2147483100;display:none;background:#04040a;',
    'font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#e7ebf5}',
    '.dms-overlay.on{display:flex}',
    '.dms-stage{position:relative;flex:1;min-width:0;overflow:hidden;background:radial-gradient(ellipse at 50% 45%,#0b0a1e 0%,#05050d 55%,#02020a 100%)}',
    '.dms-stage canvas{display:block;width:100%;height:100%;cursor:grab}',
    '.dms-stage canvas.dragging{cursor:grabbing}',
    '.dms-hud{position:absolute;left:16px;top:14px;pointer-events:none;font-size:12px;color:#9fb0d8;letter-spacing:.02em}',
    '.dms-hud b{color:#ffd27f;font-weight:600}',
    '.dms-hint{position:absolute;left:16px;bottom:12px;font-size:11px;color:#5f6c8c;pointer-events:none}',
    '.dms-tip{position:absolute;z-index:6;pointer-events:none;display:none;padding:6px 10px;border-radius:8px;',
    'background:rgba(10,10,24,.94);border:1px solid rgba(255,210,127,.4);font-size:12px;max-width:280px;',
    'box-shadow:0 8px 22px rgba(0,0,0,.6);transform:translate(-50%,-140%)}',
    '.dms-tip .n{color:#ffd27f;font-weight:600}',
    '.dms-tip .t{color:#7f8db3;font-size:11px;margin-left:6px}',
    '.dms-side{width:400px;flex:0 0 400px;display:flex;flex-direction:column;border-left:1px solid rgba(120,140,220,.16);',
    'background:linear-gradient(180deg,#0a0a16,#07070f)}',
    '.dms-head{display:flex;align-items:center;gap:8px;padding:12px 14px 10px;border-bottom:1px solid rgba(120,140,220,.14)}',
    '.dms-title{font-size:14px;font-weight:600;color:#ffd27f;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dms-x{cursor:pointer;width:26px;height:26px;border-radius:6px;display:grid;place-items:center;color:#8b98bd;',
    'border:1px solid rgba(120,140,220,.22);background:rgba(255,255,255,.03)}',
    '.dms-x:hover{color:#fff;border-color:rgba(255,210,127,.5)}',
    '.dms-tabs{display:flex;gap:4px;padding:8px 10px;border-bottom:1px solid rgba(120,140,220,.14)}',
    '.dms-tab{flex:1;text-align:center;padding:6px 0;border-radius:6px;cursor:pointer;color:#8b98bd;font-size:12px;',
    'border:1px solid transparent;user-select:none}',
    '.dms-tab:hover{color:#cfd8ea;background:rgba(255,255,255,.04)}',
    '.dms-tab.on{color:#ffd27f;background:rgba(255,210,127,.1);border-color:rgba(255,210,127,.32)}',
    '.dms-body{flex:1;overflow-y:auto;padding:12px 14px 28px}',
    '.dms-body::-webkit-scrollbar{width:8px}',
    '.dms-body::-webkit-scrollbar-thumb{background:rgba(120,140,220,.25);border-radius:4px}',
    '.dms-sec{margin-bottom:14px}',
    '.dms-sec h4{margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#65729a}',
    '.dms-kv{display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:12px;color:#c3cbe0}',
    '.dms-kv span:first-child{color:#7f8db3}',
    '.dms-kv b{color:#ffd27f;font-weight:600}',
    '.dms-name{font-size:16px;font-weight:600;color:#ffd27f;margin-bottom:2px;word-break:break-all}',
    '.dms-sub{font-size:11px;color:#6d7a9e;margin-bottom:10px}',
    '.dms-text{font-size:13px;color:#dbe2f2;line-height:1.65;background:rgba(255,255,255,.03);',
    'border:1px solid rgba(120,140,220,.14);border-radius:8px;padding:9px 10px;word-break:break-word;white-space:pre-wrap}',
    '.dms-input,.dms-select,.dms-area{width:100%;box-sizing:border-box;background:rgba(255,255,255,.04);color:#e7ebf5;',
    'border:1px solid rgba(120,140,220,.24);border-radius:7px;padding:7px 9px;font:13px/1.5 inherit;outline:none}',
    '.dms-input:focus,.dms-select:focus,.dms-area:focus{border-color:rgba(255,210,127,.55);background:rgba(255,255,255,.06)}',
    '.dms-area{min-height:70px;resize:vertical}',
    '.dms-row{display:flex;gap:8px;align-items:center}',
    '.dms-row > *{min-width:0}',
    '.dms-btn{flex:0 0 auto;padding:7px 12px;border-radius:7px;cursor:pointer;font:600 12px/1 inherit;',
    'color:#ffd27f;background:rgba(255,210,127,.1);border:1px solid rgba(255,210,127,.35);user-select:none}',
    '.dms-btn:hover{background:rgba(255,210,127,.18)}',
    '.dms-btn.ghost{color:#9fb0d8;background:rgba(255,255,255,.03);border-color:rgba(120,140,220,.24)}',
    '.dms-btn.ghost:hover{color:#fff}',
    '.dms-btn.danger{color:#ff9aa6;background:rgba(255,90,110,.1);border-color:rgba(255,90,110,.35)}',
    '.dms-btn:disabled{opacity:.45;cursor:not-allowed}',
    '.dms-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11px;',
    'border:1px solid rgba(120,140,220,.25);color:#9fb0d8}',
    '.dms-chip.imp{color:#ffd27f;border-color:rgba(255,210,127,.45);background:rgba(255,210,127,.08)}',
    '.dms-list{display:flex;flex-direction:column;gap:6px}',
    '.dms-item{padding:8px 9px;border-radius:8px;cursor:pointer;border:1px solid rgba(120,140,220,.14);',
    'background:rgba(255,255,255,.02);display:flex;gap:8px;align-items:flex-start}',
    '.dms-item:hover{border-color:rgba(255,210,127,.35);background:rgba(255,255,255,.045)}',
    '.dms-item.on{border-color:rgba(255,210,127,.55);background:rgba(255,210,127,.08)}',
    '.dms-item .d{flex:1;min-width:0}',
    '.dms-item .s{font-size:12px;color:#dbe2f2;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;',
    '-webkit-line-clamp:2;-webkit-box-orient:vertical}',
    '.dms-item .m{font-size:10.5px;color:#65729a;margin-top:2px}',
    '.dms-star{width:8px;height:8px;border-radius:50%;margin-top:4px;flex:0 0 auto}',
    '.dms-bar{height:8px;border-radius:999px;background:rgba(255,255,255,.07);overflow:hidden;margin:4px 0 2px}',
    '.dms-bar > i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#7ee0ff,#a78bfa)}',
    '.dms-bar.warn > i{background:linear-gradient(90deg,#ffd27f,#ff8a6a)}',
    '.dms-bar.danger > i{background:linear-gradient(90deg,#ff8a6a,#ff5a6e)}',
    '.dms-empty{padding:26px 10px;text-align:center;color:#5f6c8c;font-size:12.5px;line-height:1.9}',
    '.dms-svg{width:100%;height:340px;background:radial-gradient(ellipse at 50% 50%,rgba(40,30,80,.5),rgba(6,6,14,.9));',
    'border-radius:10px;border:1px solid rgba(120,140,220,.16);cursor:default}',
    '.dms-facts{display:flex;flex-direction:column;gap:4px}',
    '.dms-fact{display:flex;gap:6px;align-items:flex-start;font-size:12px;color:#b9c3da;padding:5px 8px;border-radius:6px;',
    'background:rgba(255,255,255,.025);border:1px solid rgba(120,140,220,.1)}',
    '.dms-fact .x{margin-left:auto;cursor:pointer;color:#5f6c8c;flex:0 0 auto}',
    '.dms-fact .x:hover{color:#ff9aa6}',
    '.dms-toast{position:absolute;left:50%;bottom:46px;transform:translateX(-50%);padding:9px 16px;border-radius:9px;',
    'background:rgba(16,16,34,.96);border:1px solid rgba(255,210,127,.4);color:#ffd27f;font-size:12.5px;',
    'opacity:0;transition:opacity .2s ease;pointer-events:none;z-index:8}',
    '.dms-toast.on{opacity:1}',
  ].join('\n');

  var styleEl = document.createElement('style');
  styleEl.setAttribute('data-dayu-memory-star-style', '1');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  // ───────────────────────────────────────────────────────────
  // 状态
  // ───────────────────────────────────────────────────────────

  var DATA = null;
  var selectedId = null;
  var activeTab = 'memory';
  var query = '';

  // 星图视图状态
  var view = {
    yaw: 0.4,
    pitch: 0.55,
    zoom: 1,
    panX: 0,
    panY: 0,
    autoSpin: true,
    hoverId: null,
  };

  var stars = []; // {card, pos:{x,y,z}, size, color}
  var nebulas = [];
  var fogs = [];
  var canvas = null;
  var ctx2d = null;
  var W = 0;
  var H = 0;
  var DPR = 1;

  // ───────────────────────────────────────────────────────────
  // DOM 骨架
  // ───────────────────────────────────────────────────────────

  var overlay = el('div', 'dms-overlay');
  var stage = el('div', 'dms-stage');
  var hud = el('div', 'dms-hud');
  var hint = el('div', 'dms-hint', '拖动旋转 · 滚轮缩放 · Shift+拖动平移 · 悬停看名字 · 点击星星改记忆');
  var tip = el('div', 'dms-tip');
  var toast = el('div', 'dms-toast');

  canvas = document.createElement('canvas');
  stage.appendChild(canvas);
  stage.appendChild(hud);
  stage.appendChild(hint);
  stage.appendChild(tip);
  stage.appendChild(toast);

  var side = el('div', 'dms-side');
  var head = el('div', 'dms-head');
  var titleEl = el('div', 'dms-title', '大肥鱼 · 记忆星图');
  var closeBtn = el('div', 'dms-x', '✕');
  head.appendChild(titleEl);
  head.appendChild(closeBtn);

  var tabsRow = el('div', 'dms-tabs');
  var TABS = [
    ['memory', '记忆'],
    ['relation', '关系'],
    ['context', '上下文'],
    ['status', '状态'],
  ];
  var tabEls = {};
  TABS.forEach(function (t) {
    var d = el('div', 'dms-tab' + (t[0] === activeTab ? ' on' : ''), t[1]);
    d.onclick = function () {
      switchTab(t[0]);
    };
    tabEls[t[0]] = d;
    tabsRow.appendChild(d);
  });

  var body = el('div', 'dms-body');
  side.appendChild(head);
  side.appendChild(tabsRow);
  side.appendChild(body);

  overlay.appendChild(stage);
  overlay.appendChild(side);
  document.body.appendChild(overlay);

  var launcher = null;
  if (BOOT.showLauncher !== false) {
    launcher = el('div', 'dms-launcher');
    launcher.appendChild(el('div', 'dms-dot'));
    launcher.appendChild(el('span', null, '记忆星图'));
    launcher.onclick = function () {
      open();
    };
    document.body.appendChild(launcher);
  } else {
    window.__dayuMemoryStarOpen = open;
  }

  closeBtn.onclick = close;

  function open() {
    overlay.classList.add('on');
    resize();
    if (!DATA) refresh();
    else draw();
  }
  function close() {
    overlay.classList.remove('on');
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay.classList.contains('on')) close();
  });

  function switchTab(name) {
    activeTab = name;
    Object.keys(tabEls).forEach(function (k) {
      tabEls[k].classList.toggle('on', k === name);
    });
    renderSide();
  }

  function showToast(msg, ms) {
    toast.textContent = msg;
    toast.classList.add('on');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      toast.classList.remove('on');
    }, ms || 1800);
  }

  // ───────────────────────────────────────────────────────────
  // 网络
  // ───────────────────────────────────────────────────────────

  function api(pathname, body) {
    var opts = { headers: { 'content-type': 'application/json' } };
    if (body === undefined) {
      opts.method = 'GET';
    } else {
      opts.method = 'POST';
      opts.body = JSON.stringify(body);
    }
    return fetch(API + pathname, opts).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, error: 'bad json' };
      });
    });
  }

  function refresh() {
    titleEl.textContent = '大肥鱼 · 记忆星图（读取中…）';
    api('/all')
      .then(function (d) {
        if (!d || d.ok === false) throw new Error((d && d.error) || '读取失败');
        DATA = d;
        titleEl.textContent = '大肥鱼 · 记忆星图';
        buildScene();
        renderSide();
        draw();
      })
      .catch(function (err) {
        titleEl.textContent = '大肥鱼 · 记忆星图';
        body.innerHTML = '';
        var e = el('div', 'dms-empty');
        e.innerHTML =
          '读不到记忆库。<br>' +
          '检查宿主里是否已有 cards.json，<br>' +
          '或在插件配置里指定 dataDir。<br><br>' +
          '<span style="color:#ff9aa6">' + esc((err && err.message) || err) + '</span>';
        body.appendChild(e);
      });
  }

  // ───────────────────────────────────────────────────────────
  // 场景构建
  // ───────────────────────────────────────────────────────────

  function fibSphere(n) {
    var pts = [];
    var off = 2 / n;
    var inc = Math.PI * (3 - Math.sqrt(5));
    for (var i = 0; i < n; i++) {
      var y = i * off - 1 + off / 2;
      var r = Math.sqrt(Math.max(0, 1 - y * y));
      var phi = i * inc;
      pts.push({ x: Math.cos(phi) * r, y: y, z: Math.sin(phi) * r });
    }
    return pts;
  }

  function buildScene() {
    stars = [];
    nebulas = [];
    fogs = [];
    if (!DATA) return;

    var cards = (DATA.cards || []).slice();

    // 中心大星 = 主人的生日那条（找不到才退回「最重要的一颗」）
    var bday =
      cards.filter(function (c) {
        var s = String(c.summary || '');
        return s.indexOf('生日') >= 0 && s.indexOf('主人') >= 0 && s.indexOf('大肥鱼') < 0;
      })[0] || null;
    cards.sort(function (a, b) {
      if (!!b.important !== !!a.important) return b.important ? 1 : -1;
      if (b.weight !== a.weight) return b.weight - a.weight;
      return (b.freq || 0) - (a.freq || 0);
    });

    var core = bday || cards[0] || null;
    window.__dmsCoreId = core ? core.id : null;
    window.__dmsCoreName = core ? core.summary : null;
    var rest = cards.filter(function (c) {
      return !core || c.id !== core.id;
    });

    if (core) {
      stars.push({
        card: core,
        pos: { x: 0, y: 0, z: 0 },
        isCore: true,
        size: 1,
        color: TYPE_COLORS[core.type] || TYPE_COLORS.fact,
      });
    }

    // 按类型分层，同类型在一个球壳里
    var byType = {};
    rest.forEach(function (c) {
      var t = TYPE_COLORS[c.type] ? c.type : 'fact';
      (byType[t] = byType[t] || []).push(c);
    });

    var layerIndex = 0;
    TYPE_ORDER.forEach(function (t) {
      var list = byType[t];
      if (!list || !list.length) return;
      var pts = fibSphere(list.length);
      var radius = 17 + layerIndex * 2.4;
      list.forEach(function (c, i) {
        var p = pts[i];
        var jitter = 0.94 + Math.random() * 0.12;
        stars.push({
          card: c,
          pos: { x: p.x * radius * jitter, y: p.y * radius * 0.72 * jitter, z: p.z * radius * jitter },
          size: 0.42 + Math.min(0.62, (c.weight || 0.4) * 0.62),
          color: TYPE_COLORS[t],
        });
      });
      layerIndex++;
    });

    // 星云（大团柔光，加色混合）
    var NEB = [
      { c: '#3d2f8a', a: 0.2, r: 30 },
      { c: '#6a4fc7', a: 0.17, r: 24 },
      { c: '#b06fd0', a: 0.13, r: 19 },
      { c: '#2fa8c7', a: 0.12, r: 15 },
      { c: '#ffd27f', a: 0.1, r: 11 },
    ];
    NEB.forEach(function (n) {
      for (var i = 0; i < 3; i++) {
        nebulas.push({
          color: n.c,
          alpha: n.a * (0.7 + Math.random() * 0.6),
          r: n.r * (0.7 + Math.random() * 0.7),
          pos: {
            x: (Math.random() - 0.5) * n.r * 2.4,
            y: (Math.random() - 0.5) * n.r * 1.6,
            z: (Math.random() - 0.5) * n.r * 2.4,
          },
          drift: (Math.random() - 0.5) * 0.00022,
        });
      }
    });

    // 大气雾：漂浮在星星之间的小团柔光
    for (var i = 0; i < 46; i++) {
      var far = i >= 30;
      fogs.push({
        color: far ? '#8ca0e6' : '#c8d2f5',
        alpha: far ? 0.05 + Math.random() * 0.06 : 0.09 + Math.random() * 0.12,
        r: far ? 16 + Math.random() * 20 : 7 + Math.random() * 12,
        pos: {
          x: (Math.random() - 0.5) * 120,
          y: (Math.random() - 0.5) * 80,
          z: (Math.random() - 0.5) * 120,
        },
        drift: (Math.random() - 0.5) * 0.0006,
      });
    }

    updateHud();
  }

  function updateHud() {
    var st = (DATA && DATA.stats) || {};
    hud.innerHTML =
      '<b>' + (st.cards || stars.length) + '</b> 颗记忆星 · <b>' + (st.important || 0) + '</b> 重要 · <b>' + (st.fading || 0) + '</b> 临遗忘';
  }

  // ───────────────────────────────────────────────────────────
  // 渲染
  // ───────────────────────────────────────────────────────────

  function resize() {
    if (!canvas) return;
    var rect = stage.getBoundingClientRect();
    W = Math.max(320, Math.round(rect.width));
    H = Math.max(240, Math.round(rect.height));
    DPR = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx2d = canvas.getContext('2d');
    draw();
  }
  window.addEventListener('resize', function () {
    if (overlay.classList.contains('on')) resize();
  });

  function project(p) {
    var cy = Math.cos(view.yaw);
    var sy = Math.sin(view.yaw);
    var x1 = p.x * cy - p.z * sy;
    var z1 = p.x * sy + p.z * cy;

    var cp = Math.cos(view.pitch);
    var sp = Math.sin(view.pitch);
    var y2 = p.y * cp - z1 * sp;
    var z2 = p.y * sp + z1 * cp;

    var camDist = 52 / view.zoom;
    var zc = z2 + camDist;
    if (zc < 1) zc = 1;
    var focal = 640 * view.zoom;
    var f = focal / zc;

    return {
      x: W / 2 + view.panX + x1 * f,
      y: H / 2 + view.panY + y2 * f,
      z: zc,
      f: f,
    };
  }

  function draw() {
    if (!ctx2d || !W || !H) return;
    ctx2d.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx2d.clearRect(0, 0, W, H);

    // 深空底
    var bg = ctx2d.createRadialGradient(W * 0.5, H * 0.45, 10, W * 0.5, H * 0.5, Math.max(W, H) * 0.78);
    bg.addColorStop(0, '#0c0b20');
    bg.addColorStop(0.55, '#06060f');
    bg.addColorStop(1, '#020208');
    ctx2d.fillStyle = bg;
    ctx2d.fillRect(0, 0, W, H);

    // 星云
    ctx2d.globalCompositeOperation = 'lighter';
    for (var ni = 0; ni < nebulas.length; ni++) {
      var n = nebulas[ni];
      var np = project(n.pos);
      var nr = Math.max(6, n.r * np.f * 0.5);
      ctx2d.globalAlpha = Math.min(1, n.alpha * 2.4);
      drawSprite(blobSprite(n.color), np.x, np.y, nr);
    }

    // 雾
    for (var fi = 0; fi < fogs.length; fi++) {
      var f2 = fogs[fi];
      var fp = project(f2.pos);
      var fr = Math.max(5, f2.r * fp.f * 0.45);
      ctx2d.globalAlpha = Math.min(1, f2.alpha * 2.6);
      drawSprite(blobSprite(f2.color), fp.x, fp.y, fr);
    }
    ctx2d.globalAlpha = 1;
    ctx2d.globalCompositeOperation = 'source-over';

    // 投影所有星
    var proj = stars.map(function (s) {
      return { s: s, p: project(s.pos) };
    });
    proj.sort(function (a, b) {
      return b.p.z - a.p.z;
    });

    var posById = {};
    proj.forEach(function (o) {
      posById[o.s.card.id] = o;
    });

    // 中心连线（淡淡的蛛网）
    var coreO = proj.find(function (o) {
      return o.s.isCore;
    });
    if (coreO) {
      ctx2d.lineWidth = 1;
      for (var i = 0; i < proj.length; i++) {
        var o = proj[i];
        if (o.s.isCore) continue;
        var alpha = 0.05 + 0.09 * Math.min(1, o.s.size);
        ctx2d.strokeStyle = 'rgba(159,176,232,' + alpha.toFixed(3) + ')';
        ctx2d.beginPath();
        ctx2d.moveTo(coreO.p.x, coreO.p.y);
        ctx2d.lineTo(o.p.x, o.p.y);
        ctx2d.stroke();
      }
    }

    // 关联记忆之间的线（青色，明显一点）
    var edges = (DATA && DATA.relatedEdges) || [];
    ctx2d.lineWidth = 1;
    for (var ei = 0; ei < edges.length; ei++) {
      var e = edges[ei];
      var a = posById[e.a];
      var b = posById[e.b];
      if (!a || !b) continue;
      var hot = view.hoverId && (view.hoverId === e.a || view.hoverId === e.b);
      ctx2d.strokeStyle = hot ? 'rgba(126,224,255,0.55)' : 'rgba(126,224,255,0.16)';
      ctx2d.beginPath();
      ctx2d.moveTo(a.p.x, a.p.y);
      ctx2d.lineTo(b.p.x, b.p.y);
      ctx2d.stroke();
    }

    // 星星本体
    for (var si = 0; si < proj.length; si++) {
      var it = proj[si];
      var c = it.s.card;
      var px = it.p.x;
      var py = it.p.y;
      var base = it.s.size * it.p.f * 1.5;
      var hovered = view.hoverId === c.id;
      var selected = selectedId === c.id;
      var faded = (c.retention != null ? c.retention : 1) < 0.35 && !c.important;

      var scale = hovered ? 1.35 : selected ? 1.18 : 1;
      var r = Math.max(1.2, base * scale);

      ctx2d.globalCompositeOperation = 'lighter';

      // 柔光晕
      var glowR = r * (it.s.isCore ? 5.6 : hovered ? 3.8 : 2.9);
      ctx2d.globalAlpha = (faded ? 0.28 : 1) * (hovered ? 1.2 : 1);
      drawSprite(blobSprite(it.s.color), px, py, glowR);

      // 星芒（重要星才有）
      if (c.important || it.s.isCore) {
        var rayR = r * (it.s.isCore ? 7.5 : 5.2);
        ctx2d.globalAlpha = faded ? 0.3 : hovered ? 1 : 0.78;
        drawSprite(raySprite(it.s.color), px, py, rayR);
      }
      ctx2d.globalAlpha = 1;
      ctx2d.globalCompositeOperation = 'source-over';

      // 实体核
      var coreR = Math.max(1, r * (it.s.isCore ? 1.15 : 0.6));
      drawSprite(coreSprite(it.s.color), px, py, coreR * 1.9);

      if (selected) {
        ctx2d.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx2d.lineWidth = 1.4;
        ctx2d.beginPath();
        ctx2d.arc(px, py, coreR * 2.6 + 3, 0, Math.PI * 2);
        ctx2d.stroke();
      }
    }

    // 重要记忆的名字悬浮在星星上方（带简易避让，避免两行字叠在一起）
    ctx2d.globalCompositeOperation = 'source-over';
    ctx2d.textAlign = 'center';
    ctx2d.textBaseline = 'bottom';
    var placed = [];
    var overlaps = function (x, y, w, h) {
      for (var i = 0; i < placed.length; i++) {
        var r = placed[i];
        if (x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y) return true;
      }
      return false;
    };
    // 核心星先画，保证它永远在最上层位置
    var order = proj.slice().sort(function (a, b) {
      if (a.s.isCore === b.s.isCore) return b.p.f - a.p.f;
      return a.s.isCore ? -1 : 1;
    });
    for (var li = 0; li < order.length; li++) {
      var lo = order[li];
      var lc = lo.s.card;
      if (!lc.important && !lo.s.isCore && lo.s.card.id !== view.hoverId) continue;
      var label = lc.name || (lc.summary || '').slice(0, 10);
      if (!label) continue;
      var fontSize = lo.s.isCore ? Math.max(12, Math.min(17, 9 + lo.p.f * 2.2)) : Math.max(9.5, Math.min(13, lo.p.f * 1.9));
      ctx2d.font = '600 ' + fontSize.toFixed(1) + 'px -apple-system,"Microsoft YaHei",sans-serif';
      var tw = Math.min(240, ctx2d.measureText(label).width);
      var th = fontSize + 4;
      var baseTy = lo.p.y - Math.max(7, lo.s.size * lo.p.f * 2.6);
      var tx = Math.max(tw / 2 + 4, Math.min(canvas.clientWidth - tw / 2 - 4, lo.p.x));
      var ty = baseTy;
      // 最多往上挪三次找空位；实在挤就这一帧不画，别叠成一片
      var tries = 0;
      while (tries < 3 && overlaps(tx - tw / 2, ty - th, tw, th)) {
        ty -= th + 2;
        tries++;
      }
      if (overlaps(tx - tw / 2, ty - th, tw, th)) continue;
      placed.push({ x: tx - tw / 2, y: ty - th, w: tw, h: th });
      ctx2d.lineWidth = 3;
      ctx2d.strokeStyle = 'rgba(0,0,0,0.72)';
      ctx2d.strokeText(label, tx, ty);
      ctx2d.fillStyle = lc.important ? '#ffd27f' : 'rgba(220,230,250,0.9)';
      ctx2d.fillText(label, tx, ty);
    }
  }

  function drawRaysUnused() {}

  // 动画循环：慢速自转 + 漂移
  var lastT = 0;
  function tick(t) {
    var dt = lastT ? Math.min(64, t - lastT) : 16;
    lastT = t;
    if (overlay.classList.contains('on')) {
      if (view.autoSpin && !view.hoverId) {
        view.yaw += dt * 0.000045;
      }
      for (var i = 0; i < nebulas.length; i++) {
        nebulas[i].pos.x += nebulas[i].drift * dt * 0.06;
        nebulas[i].pos.y += nebulas[i].drift * dt * 0.04;
      }
      for (var j = 0; j < fogs.length; j++) {
        fogs[j].pos.y += fogs[j].drift * dt * 0.05;
        fogs[j].pos.x += fogs[j].drift * dt * 0.03;
        if (Math.abs(fogs[j].pos.y) > 56) fogs[j].pos.y *= -1;
        if (Math.abs(fogs[j].pos.x) > 76) fogs[j].pos.x *= -1;
      }
      draw();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ───────────────────────────────────────────────────────────
  // 交互
  // ───────────────────────────────────────────────────────────

  var drag = null;

  canvas.addEventListener('mousedown', function (e) {
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, pan: !!e.shiftKey, moved: false };
    canvas.classList.add('dragging');
  });

  window.addEventListener('mouseup', function () {
    if (!drag) return;
    var wasDrag = drag.moved;
    var startX = drag.sx;
    var startY = drag.sy;
    drag = null;
    canvas.classList.remove('dragging');
    if (!wasDrag) {
      pickAt(startX, startY);
    }
  });

  canvas.addEventListener('mousemove', function (e) {
    if (drag) {
      var dx = e.clientX - drag.x;
      var dy = e.clientY - drag.y;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true;
      if (drag.pan) {
        view.panX += dx;
        view.panY += dy;
      } else {
        view.yaw += dx * 0.006;
        view.pitch = Math.max(-1.2, Math.min(1.2, view.pitch + dy * 0.005));
      }
      drag.x = e.clientX;
      drag.y = e.clientY;
      tip.style.display = 'none';
      draw();
      return;
    }
    // 悬停
    var hit = hitTest(e.clientX, e.clientY);
    if (hit) {
      view.hoverId = hit.id;
      tip.style.display = 'block';
      tip.innerHTML = '<span class="n">' + esc(hit.name || hit.summary) + '</span><span class="t">' + esc(TYPE_LABELS[hit.type] || '日常') + '</span>';
      var rect = stage.getBoundingClientRect();
      tip.style.left = e.clientX - rect.left + 'px';
      tip.style.top = e.clientY - rect.top + 'px';
      canvas.style.cursor = 'pointer';
    } else {
      view.hoverId = null;
      tip.style.display = 'none';
      canvas.style.cursor = 'grab';
    }
  });

  canvas.addEventListener('mouseleave', function () {
    tip.style.display = 'none';
    view.hoverId = null;
  });

  canvas.addEventListener(
    'wheel',
    function (e) {
      e.preventDefault();
      var k = e.deltaY > 0 ? 0.92 : 1.08;
      view.zoom = Math.max(0.35, Math.min(3.2, view.zoom * k));
      draw();
    },
    { passive: false }
  );

  function hitTest(clientX, clientY) {
    if (!stars.length) return null;
    var rect = stage.getBoundingClientRect();
    var mx = clientX - rect.left;
    var my = clientY - rect.top;
    var best = null;
    var bestD = 1e9;
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var p = project(s.pos);
      var r = Math.max(9, s.size * p.f * 1.5 + 6);
      var d = Math.hypot(p.x - mx, p.y - my);
      if (d < r && d < bestD) {
        bestD = d;
        best = s.card;
      }
    }
    return best;
  }

  function pickAt(clientX, clientY) {
    var hit = hitTest(clientX, clientY);
    if (!hit) return;
    selectedId = hit.id;
    switchTab('memory');
    renderSide();
    draw();
  }

  // ───────────────────────────────────────────────────────────
  // 侧边栏
  // ───────────────────────────────────────────────────────────

  function renderSide() {
    if (!DATA) return;
    body.innerHTML = '';
    if (activeTab === 'memory') renderMemoryTab();
    else if (activeTab === 'relation') renderRelationTab();
    else if (activeTab === 'context') renderContextTab();
    else renderStatusTab();
  }

  function cardById(id) {
    if (!DATA) return null;
    for (var i = 0; i < DATA.cards.length; i++) if (DATA.cards[i].id === id) return DATA.cards[i];
    return null;
  }

  function renderMemoryTab() {
    var card = cardById(selectedId);

    // 搜索 + 列表
    var sec = el('div', 'dms-sec');
    var row = el('div', 'dms-row');
    var input = el('input', 'dms-input');
    input.placeholder = '搜记忆「火锅」「考研」…';
    input.value = query;
    input.oninput = function () {
      query = input.value.trim();
      renderCardList(listWrap);
    };
    var addBtn = el('div', 'dms-btn ghost', '＋ 新记忆');
    addBtn.onclick = function () {
      addNewCard();
    };
    row.appendChild(input);
    row.appendChild(addBtn);
    sec.appendChild(row);
    body.appendChild(sec);

    var listWrap = el('div', 'dms-list');
    body.appendChild(listWrap);
    renderCardList(listWrap);

    if (card) {
      body.appendChild(el('div', 'dms-sec')).appendChild(el('hr', null));
      renderCardDetail(card);
    }
  }

  function filteredCards() {
    var list = (DATA && DATA.cards) || [];
    var q = query.toLowerCase();
    var out = q
      ? list.filter(function (c) {
          return (c.summary || '').toLowerCase().indexOf(q) !== -1 || (c.keywords || []).some(function (k) { return k.indexOf(q) !== -1; });
        })
      : list.slice();
    out.sort(function (a, b) {
      if (!!b.important !== !!a.important) return b.important ? 1 : -1;
      return (b.last_used || 0) - (a.last_used || 0);
    });
    return out;
  }

  function renderCardList(wrap) {
    wrap.innerHTML = '';
    var list = filteredCards();
    if (!list.length) {
      wrap.appendChild(el('div', 'dms-empty', query ? '没有匹配的记忆' : '记忆库还是空的。\n让智能体用 dayu_memory_remember 写几条，或点「＋ 新记忆」。'));
      return;
    }
    list.slice(0, 200).forEach(function (c) {
      var item = el('div', 'dms-item' + (c.id === selectedId ? ' on' : ''));
      var dot = el('div', 'dms-star');
      dot.style.background = TYPE_COLORS[c.type] || TYPE_COLORS.fact;
      dot.style.boxShadow = '0 0 8px 2px ' + rgba(TYPE_COLORS[c.type] || TYPE_COLORS.fact, 0.6);
      var d = el('div', 'd');
      d.appendChild(el('div', 's', c.summary));
      d.appendChild(
        el(
          'div',
          'm',
          (TYPE_LABELS[c.type] || '日常') +
            ' · ' +
            relTime(Math.max(c.last_used || 0, c.created || 0)) +
            ' · 保留 ' +
            Math.round((c.retention || 0) * 100) +
            '%' +
            (c.important ? ' · 重要' : '')
        )
      );
      item.appendChild(dot);
      item.appendChild(d);
      item.onclick = function () {
        selectedId = c.id;
        renderSide();
        draw();
      };
      wrap.appendChild(item);
    });
  }

  function renderCardDetail(c) {
    var sec = el('div', 'dms-sec');
    sec.appendChild(el('div', 'dms-name', c.name || c.summary));
    sec.appendChild(
      el('div', 'dms-sub', (TYPE_LABELS[c.type] || '日常') + ' · 创建 ' + relTime(c.created) + ' · 最近想起 ' + relTime(c.last_used))
    );

    var chips = el('div', 'dms-row');
    chips.style.flexWrap = 'wrap';
    chips.appendChild(el('span', 'dms-chip' + (c.important ? ' imp' : ''), c.important ? '★ 重要（永不遗忘）' : '普通'));
    chips.appendChild(el('span', 'dms-chip', '权重 ' + (c.weight != null ? c.weight.toFixed(2) : '—')));
    chips.appendChild(el('span', 'dms-chip', '保留 ' + Math.round((c.retention || 0) * 100) + '%'));
    chips.appendChild(el('span', 'dms-chip', '稳定期 ' + Math.round(c.stabilityDays || 0) + ' 天'));
    chips.appendChild(el('span', 'dms-chip', '已 ' + Math.round(c.ageDays || 0) + ' 天'));
    sec.appendChild(chips);
    body.appendChild(sec);

    // 摘要
    var s1 = el('div', 'dms-sec');
    s1.appendChild(el('h4', null, '记忆内容'));
    var area = el('textarea', 'dms-area');
    area.value = c.summary || '';
    s1.appendChild(area);
    body.appendChild(s1);

    // 类型 + 重要 + 权重
    var s2 = el('div', 'dms-sec');
    s2.appendChild(el('h4', null, '分类与权重'));
    var r1 = el('div', 'dms-row');
    var sel = el('select', 'dms-select');
    TYPE_ORDER.forEach(function (t) {
      var o = el('option', null, TYPE_LABELS[t]);
      o.value = t;
      if (c.type === t) o.selected = true;
      sel.appendChild(o);
    });
    r1.appendChild(sel);
    var imp = el('div', 'dms-btn ghost', c.important ? '取消重要' : '设为重要');
    imp.style.flex = '0 0 auto';
    var impState = !!c.important;
    imp.onclick = function () {
      impState = !impState;
      imp.textContent = impState ? '取消重要' : '设为重要';
      imp.style.color = impState ? '#ffd27f' : '#9fb0d8';
    };
    r1.appendChild(imp);
    s2.appendChild(r1);

    var r2 = el('div', 'dms-row');
    r2.style.marginTop = '8px';
    var wInput = el('input', 'dms-input');
    wInput.type = 'number';
    wInput.min = '0';
    wInput.max = '1';
    wInput.step = '0.05';
    wInput.placeholder = '权重覆盖 0~1（留空=自动）';
    wInput.value = c.weightOverride == null ? '' : String(c.weightOverride);
    r2.appendChild(wInput);
    s2.appendChild(r2);
    var r3 = el('div', 'dms-row');
    r3.style.marginTop = '8px';
    var saveBtn = el('div', 'dms-btn', '保存修改');
    saveBtn.onclick = function () {
      var patch = { summary: area.value, type: sel.value, important: impState };
      var wv = wInput.value.trim();
      patch.weightOverride = wv === '' ? null : Number(wv);
      api('/card/update', { id: c.id, patch: patch })
        .then(function (r) {
          if (r && r.ok) {
            showToast('已保存');
            refresh();
          } else showToast('保存失败：' + ((r && r.reason) || 'unknown'));
        })
        .catch(function () {
          showToast('保存失败');
        });
    };
    var delBtn = el('div', 'dms-btn danger', '删除这颗记忆');
    delBtn.onclick = function () {
      if (!window.confirm('删除这条记忆？只删这一条，其它记忆不受影响。')) return;
      api('/card/delete', { id: c.id })
        .then(function (r) {
          if (r && r.ok) {
            selectedId = null;
            showToast('已删除');
            refresh();
          } else showToast('删除失败');
        })
        .catch(function () {
          showToast('删除失败');
        });
    };
    r3.appendChild(saveBtn);
    r3.appendChild(delBtn);
    s2.appendChild(r3);
    body.appendChild(s2);

    // 细节
    var s3 = el('div', 'dms-sec');
    s3.appendChild(el('h4', null, '细节外挂（' + (c.facts || []).length + '）'));
    var fl = el('div', 'dms-facts');
    (c.facts || []).forEach(function (f) {
      var row = el('div', 'dms-fact');
      row.appendChild(el('span', null, f.fact));
      var x = el('span', 'x', '✕');
      x.onclick = function () {
        api('/fact/delete', { factId: f.id }).then(function () {
          refresh();
        });
      };
      row.appendChild(x);
      fl.appendChild(row);
    });
    if (!(c.facts || []).length) fl.appendChild(el('div', 'dms-empty', '还没有细节。'));
    s3.appendChild(fl);

    var r4 = el('div', 'dms-row');
    r4.style.marginTop = '8px';
    var fIn = el('input', 'dms-input');
    fIn.placeholder = '补一条细节…';
    var fBtn = el('div', 'dms-btn ghost', '添加');
    fBtn.onclick = function () {
      var v = fIn.value.trim();
      if (!v) return;
      api('/fact/add', { cardId: c.id, fact: v }).then(function () {
        fIn.value = '';
        refresh();
      });
    };
    r4.appendChild(fIn);
    r4.appendChild(fBtn);
    s3.appendChild(r4);
    body.appendChild(s3);
  }

  function addNewCard() {
    var text = window.prompt('新的记忆（一句话）：');
    if (!text || !text.trim()) {
      showToast('先写点内容再添加吧');
      return;
    }
    api('/card/add', { item: { summary: text.trim(), type: 'auto' } }).then(function (r) {
      if (r && r.ok) {
        var tName =
          { rule: '规则', preference: '偏好', goal: '目标', emotion: '情绪', fact: '日常' }[r.type] || r.type || '';
        var names = (r.related || []).map(function (x) {
          return x.name;
        });
        showToast(
          '已添加 · 自动归为「' + tName + '」' +
            (names.length ? ' · 连到 ' + names.length + ' 条：' + names.join('、') : ' · 暂未找到相关记忆'),
          4200
        );
        refresh();
      } else {
        showToast('添加失败：' + ((r && (r.error || r.reason)) || '未知原因'), 4200);
      }
    });
  }

  // ── 关系图 ────────────────────────────────────────────────

  var relSel = null; // {kind:'node'|'edge', id}

  function renderRelationTab() {
    var rel = (DATA && DATA.relations) || { nodes: [], edges: [] };
    var nodes = rel.nodes || [];
    var edges = rel.edges || [];

    var sec = el('div', 'dms-sec');
    sec.appendChild(el('h4', null, '人物关系图（可改）'));
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'dms-svg');
    svg.setAttribute('viewBox', '0 0 360 340');
    sec.appendChild(svg);
    body.appendChild(sec);

    // 布局：主人中心，大肥鱼紧邻，朋友环形
    var owner = nodes.find(function (n) {
      return n.role === 'owner';
    });
    var self = nodes.find(function (n) {
      return n.role === 'self';
    });
    var friends = nodes.filter(function (n) {
      return n.role !== 'owner' && n.role !== 'self';
    });

    var pos = {};
    var cx = 180;
    var cy = 168;
    if (owner) pos[owner.id] = { x: cx, y: cy };
    if (self) pos[self.id] = { x: cx, y: cy - 62 };
    var fr = Math.min(132, 62 + friends.length * 4);
    friends.forEach(function (n, i) {
      var a = (i / Math.max(1, friends.length)) * Math.PI * 2 - Math.PI / 2;
      pos[n.id] = { x: cx + Math.cos(a) * fr, y: cy + Math.sin(a) * fr * 0.86 };
    });

    var NS = 'http://www.w3.org/2000/svg';
    function mk(tag, attrs) {
      var n = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) {
        n.setAttribute(k, attrs[k]);
      });
      return n;
    }

    // 边
    edges.forEach(function (e) {
      var a = pos[e.from];
      var b = pos[e.to];
      if (!a || !b) return;
      var isSel = relSel && relSel.kind === 'edge' && relSel.id === [e.from, e.to].sort().join('|');
      var line = mk('line', {
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        stroke: isSel ? 'rgba(255,210,127,.95)' : e.kind === 'core' ? 'rgba(255,210,127,.5)' : e.custom ? 'rgba(126,224,255,.6)' : 'rgba(140,160,220,.25)',
        'stroke-width': isSel ? 2 : 1,
      });
      if (e.custom) {
        line.style.cursor = 'pointer';
        line.addEventListener('click', function () {
          relSel = { kind: 'edge', id: [e.from, e.to].sort().join('|'), from: e.from, to: e.to, rel: e.rel };
          renderSide();
        });
      }
      svg.appendChild(line);
      // 关系文案
      if (e.kind === 'core' || e.custom) {
        var t = mk('text', {
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2 - 3,
          fill: 'rgba(180,195,230,.75)',
          'font-size': '8',
          'text-anchor': 'middle',
        });
        t.textContent = e.rel || '';
        svg.appendChild(t);
      }
    });

    // 节点
    nodes.forEach(function (n) {
      var p = pos[n.id];
      if (!p) return;
      var isSel = relSel && relSel.kind === 'node' && relSel.id === n.id;
      var isCore = n.role === 'owner' || n.role === 'self';
      var g = mk('g', {});
      var c = mk('circle', {
        cx: p.x,
        cy: p.y,
        r: isCore ? 13 : 9,
        fill: n.role === 'owner' ? 'rgba(255,210,127,.18)' : n.role === 'self' ? 'rgba(126,224,255,.18)' : 'rgba(160,175,235,.14)',
        stroke: isSel ? 'rgba(255,255,255,.95)' : n.role === 'owner' ? 'rgba(255,210,127,.85)' : n.role === 'self' ? 'rgba(126,224,255,.8)' : 'rgba(150,168,230,.55)',
        'stroke-width': isSel ? 2 : 1.3,
      });
      c.style.cursor = 'pointer';
      c.addEventListener('click', function () {
        relSel = { kind: 'node', id: n.id };
        renderSide();
      });
      g.appendChild(c);
      var t = mk('text', {
        x: p.x,
        y: p.y + (isCore ? 26 : 22),
        fill: isCore ? '#ffd27f' : 'rgba(200,212,240,.85)',
        'font-size': isCore ? '10' : '9',
        'text-anchor': 'middle',
      });
      t.textContent = n.name || '';
      g.appendChild(t);
      svg.appendChild(g);
    });

    // 编辑区
    var e1 = el('div', 'dms-sec');
    e1.appendChild(el('h4', null, '选中项'));
    if (!relSel) {
      e1.appendChild(el('div', 'dms-empty', '点一个圆点看/改关系；点青色连线可删除自定义关系。'));
    } else if (relSel.kind === 'node') {
      var node = nodes.find(function (x) {
        return x.id === relSel.id;
      });
      if (!node) {
        relSel = null;
        e1.appendChild(el('div', 'dms-empty', '该人物已不在图里。'));
      } else {
        var rName = el('div', 'dms-row');
        var nIn = el('input', 'dms-input');
        nIn.value = node.name || '';
        var nBtn = el('div', 'dms-btn', '改名');
        nBtn.onclick = function () {
          api('/relations/rename', { id: node.id, name: nIn.value }).then(function (r) {
            if (r && r.ok) {
              showToast('已改名');
              relSel = { kind: 'node', id: node.id };
              refresh();
            } else showToast('改名失败');
          });
        };
        rName.appendChild(nIn);
        rName.appendChild(nBtn);
        e1.appendChild(rName);

        if (node.role !== 'owner' && node.role !== 'self') {
          var ro = el('div', 'dms-row');
          ro.style.marginTop = '8px';
          var oIn = el('input', 'dms-input');
          oIn.placeholder = '主人与TA的关系';
          oIn.value = node.ownerRel || '同群';
          var sIn = el('input', 'dms-input');
          sIn.placeholder = '大肥鱼与TA的关系';
          sIn.value = node.selfRel || '朋友';
          ro.appendChild(oIn);
          ro.appendChild(sIn);
          e1.appendChild(ro);
          var rb = el('div', 'dms-row');
          rb.style.marginTop = '8px';
          var rBtn = el('div', 'dms-btn', '保存关系');
          rBtn.onclick = function () {
            api('/relations/setRels', { id: node.id, ownerRel: oIn.value, selfRel: sIn.value }).then(function (r) {
              if (r && r.ok) {
                showToast('已保存关系');
                relSel = { kind: 'node', id: node.id };
                refresh();
              } else showToast('保存失败');
            });
          };
          var delN = el('div', 'dms-btn danger', '移除');
          delN.onclick = function () {
            if (!window.confirm('从关系图里移除「' + (node.name || '该人物') + '」？')) return;
            api('/relations/deleteNode', { id: node.id }).then(function () {
              relSel = null;
              showToast('已移除');
              refresh();
            });
          };
          rb.appendChild(rBtn);
          rb.appendChild(delN);
          e1.appendChild(rb);
        }
      }
    } else {
      var eDel = el('div', 'dms-btn danger', '删除这条关系线');
      eDel.onclick = function () {
        if (!window.confirm('删除这条关系？')) return;
        api('/relations/deleteEdge', { from: relSel.from, to: relSel.to }).then(function () {
          relSel = null;
          showToast('已删除');
          refresh();
        });
      };
      e1.appendChild(eDel);
    }
    body.appendChild(e1);

    // 新增人物 / 连线
    var e2 = el('div', 'dms-sec');
    e2.appendChild(el('h4', null, '添加'));
    var a1 = el('div', 'dms-row');
    var aIn = el('input', 'dms-input');
    aIn.placeholder = '新人物名字';
    var aBtn = el('div', 'dms-btn ghost', '加人物');
    aBtn.onclick = function () {
      if (!aIn.value.trim()) return;
      api('/relations/addNode', { name: aIn.value.trim() }).then(function (r) {
        if (r && r.ok) {
          showToast('已添加');
          refresh();
        } else showToast('添加失败');
      });
    };
    a1.appendChild(aIn);
    a1.appendChild(aBtn);
    e2.appendChild(a1);
    body.appendChild(e2);
  }

  // ── 上下文 ────────────────────────────────────────────────

  function renderContextTab() {
    var c = (DATA && DATA.context) || {};
    if (!c.available) {
      var e = el('div', 'dms-empty');
      e.innerHTML =
        '还没有上下文统计文件。<br>' +
        '这是宿主自己写的 <code>context_usage.json</code>，<br>' +
        '位置：<br><span style="color:#7f8db3;font-size:11px">' + esc(c.path || '') + '</span>';
      body.appendChild(e);
      return;
    }

    var s1 = el('div', 'dms-sec');
    s1.appendChild(el('h4', null, '本次请求'));
    var bar1 = el('div', 'dms-bar' + (c.usedPct > 90 ? ' danger' : c.usedPct > 70 ? ' warn' : ''));
    var i1 = document.createElement('i');
    i1.style.width = Math.min(100, c.usedPct || 0) + '%';
    bar1.appendChild(i1);
    s1.appendChild(bar1);
    var kv1 = el('div', 'dms-kv');
    kv1.appendChild(el('span', null, '已用 ' + (c.usedPct || 0) + '%'));
    var b1 = el('b', null, fmtNum(c.lastPromptTokens) + ' / ' + fmtNum(c.windowTokens));
    kv1.appendChild(b1);
    s1.appendChild(kv1);
    var kv1b = el('div', 'dms-kv');
    kv1b.appendChild(el('span', null, '剩余空间'));
    kv1b.appendChild(el('b', null, fmtNum(c.remainTokens) + ' tokens'));
    s1.appendChild(kv1b);
    body.appendChild(s1);

    var s2 = el('div', 'dms-sec');
    s2.appendChild(el('h4', null, '历史累计'));
    var bar2 = el('div', 'dms-bar' + (c.totalMult > 20 ? ' danger' : c.totalMult > 6 ? ' warn' : ''));
    var i2 = document.createElement('i');
    i2.style.width = Math.min(100, ((c.totalAll || 0) / (c.windowTokens || 1)) * 8) + '%';
    bar2.appendChild(i2);
    s2.appendChild(bar2);
    var kv2 = el('div', 'dms-kv');
    kv2.appendChild(el('span', null, '共 ' + fmtNum(c.totalAll) + ' tokens'));
    kv2.appendChild(el('b', null, c.totalMult + ' × 窗口'));
    s2.appendChild(kv2);
    var kv3 = el('div', 'dms-kv');
    kv3.appendChild(el('span', null, '请求次数'));
    kv3.appendChild(el('b', null, String(c.totalCalls || 0)));
    s2.appendChild(kv3);
    var kv4 = el('div', 'dms-kv');
    kv4.appendChild(el('span', null, '输入 / 输出'));
    kv4.appendChild(el('b', null, fmtNum(c.totalPromptTokens) + ' / ' + fmtNum(c.totalCompletionTokens)));
    s2.appendChild(kv4);
    body.appendChild(s2);

    var per = c.perSession || {};
    var keys = Object.keys(per);
    if (keys.length) {
      var s3 = el('div', 'dms-sec');
      s3.appendChild(el('h4', null, '分会话'));
      keys
        .sort(function (a, b) {
          return (per[b].totalPromptTokens || 0) - (per[a].totalPromptTokens || 0);
        })
        .forEach(function (k) {
          var v = per[k] || {};
          var name = SESSION_LABELS[k] || (k === '3387982960' ? 'QQ·主人' : k.slice(0, 10));
          var row = el('div', 'dms-kv');
          row.appendChild(el('span', null, name));
          row.appendChild(el('b', null, fmtNum(v.totalPromptTokens || 0) + ' · ' + (v.calls || 0) + ' 次'));
          s3.appendChild(row);
        });
      body.appendChild(s3);
    }
  }

  // ── 状态 ──────────────────────────────────────────────────

  function renderStatusTab() {
    var st = (DATA && DATA.stats) || {};
    var cards = (DATA && DATA.cards) || [];

    var s1 = el('div', 'dms-sec');
    s1.appendChild(el('h4', null, '记忆库'));
    var rows1 = [
      ['路径', st.dataDir || '—'],
      ['识别方式', st.resolvedBy || '—'],
      ['卡片 / 细节', (st.cards || 0) + ' / ' + (st.facts || 0)],
      ['重要（永不遗忘）', String(st.important || 0)],
      ['濒临遗忘', String(st.fading || 0)],
    ];
    rows1.forEach(function (r) {
      var kv = el('div', 'dms-kv');
      kv.appendChild(el('span', null, r[0]));
      kv.appendChild(el('b', null, r[1]));
      s1.appendChild(kv);
    });
    body.appendChild(s1);

    var s2 = el('div', 'dms-sec');
    s2.appendChild(el('h4', null, '记忆模型'));
    var eb = st.ebbinghaus || {};
    var rows2 = [
      ['合并阈值', '相似度 ≥ ' + (st.mergeSim != null ? st.mergeSim : 0.85)],
      ['稳定期基数', (eb.sDay || 90) + ' 天 × 权重'],
      ['遗忘阈值', '保留率 < ' + (eb.forgetR != null ? eb.forgetR : 0.2)],
      ['免遗忘', '重要 或 被想起 ≥ ' + (eb.forgetFreq || 4) + ' 次'],
    ];
    rows2.forEach(function (r) {
      var kv = el('div', 'dms-kv');
      kv.appendChild(el('span', null, r[0]));
      kv.appendChild(el('b', null, r[1]));
      s2.appendChild(kv);
    });
    body.appendChild(s2);

    var s3 = el('div', 'dms-sec');
    s3.appendChild(el('h4', null, '类型分布'));
    var by = st.byType || {};
    TYPE_ORDER.forEach(function (t) {
      if (!by[t]) return;
      var kv = el('div', 'dms-kv');
      kv.appendChild(el('span', null, TYPE_LABELS[t]));
      kv.appendChild(el('b', null, String(by[t])));
      s3.appendChild(kv);
    });
    body.appendChild(s3);

    var s4 = el('div', 'dms-sec');
    s4.appendChild(el('h4', null, '最该被想起的（保留率最低）'));
    var fading = cards
      .filter(function (c) {
        return !c.important;
      })
      .sort(function (a, b) {
        return (a.retention || 0) - (b.retention || 0);
      })
      .slice(0, 6);
    if (!fading.length) s4.appendChild(el('div', 'dms-empty', '没有即将遗忘的记忆。'));
    fading.forEach(function (c) {
      var kv = el('div', 'dms-kv');
      var sp = el('span', null, (c.name || c.summary || '').slice(0, 14));
      kv.appendChild(sp);
      kv.appendChild(el('b', null, Math.round((c.retention || 0) * 100) + '%'));
      s4.appendChild(kv);
    });
    body.appendChild(s4);

    var s5 = el('div', 'dms-sec');
    s5.appendChild(el('h4', null, '维护'));
    var r5 = el('div', 'dms-row');
    var sweepBtn = el('div', 'dms-btn ghost', '预演遗忘（不删）');
    sweepBtn.onclick = function () {
      api('/sweep', { dryRun: true }).then(function (r) {
        if (r && r.ok) showToast('会遗忘 ' + (r.dropped || 0) + ' 条');
        else showToast('失败');
      });
    };
    var sweepRun = el('div', 'dms-btn danger', '执行遗忘');
    sweepRun.onclick = function () {
      if (!window.confirm('按艾宾浩斯曲线删掉已经淡出到阈值的记忆？（重要与高频记忆不动）')) return;
      api('/sweep', { dryRun: false }).then(function (r) {
        if (r && r.ok) {
          showToast('已遗忘 ' + (r.dropped || 0) + ' 条');
          refresh();
        } else showToast('失败');
      });
    };
    var reload = el('div', 'dms-btn ghost', '刷新');
    reload.onclick = function () {
      refresh();
    };
    r5.appendChild(sweepBtn);
    r5.appendChild(sweepRun);
    r5.appendChild(reload);
    s5.appendChild(r5);
    body.appendChild(s5);

    // 宿主在线状态（可选）
    var s6 = el('div', 'dms-sec');
    s6.appendChild(el('h4', null, '宿主连接'));
    var kvb = el('div', 'dms-kv');
    kvb.appendChild(el('span', null, '记忆读写'));
    kvb.appendChild(el('b', null, '正常'));
    s6.appendChild(kvb);
    body.appendChild(s6);
  }

  // 首屏预热：拿到数据就先建好场景，打开时不卡
  setTimeout(function () {
    if (!DATA) {
      api('/all')
        .then(function (d) {
          if (d && d.ok !== false) {
            DATA = d;
            buildScene();
            renderSide();
          }
        })
        .catch(function () {});
    }
  }, 400);
})();
