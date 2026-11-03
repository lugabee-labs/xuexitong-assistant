// 板块①（v2.3）回归测试：面板 DOM 指纹随机化 + 拟人化（随机暂停 / 作息时段）
// 运行：node tests/fingerprint.test.js
//
// 为什么要单独测：
//   1) 指纹随机化是"每次加载都不同"的性质，只能靠两次独立 boot 对比来验证；
//   2) 拟人化暂停必须和 autoPlay 不打架（自己暂停不被自己掀掉、弹题优先），
//      这类时序问题在真浏览器里很难稳定复现，用 mock 视频对象最可靠。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'xuexitong-assistant.user.js'), 'utf8');

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name + ' → ' + g); }
  else { fail++; console.log('  FAIL ' + name + ' → 实得 ' + g + '，期望 ' + w); }
}
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 轮询直到条件成立：每次先跑一拍 tick，再判断，避免"固定 sleep + 假设时序"（t18/F1' 竞态根因之一）。
 * 返回是否在超时前成立；超时后再补一拍，让调用方的断言拿到最终状态。 */
async function tickUntil(inst, cond, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 3000)) {
    inst.tick();
    if (cond()) return true;
    await sleep(25);
  }
  inst.tick();
  return !!cond();
}

// ---------------- 最小 DOM / 油猴 API mock ----------------
function makeEl(tag, created) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    nodeType: 1,
    style: { cssText: '', setProperty() {}, getPropertyValue() { return ''; } },
    dataset: {},
    className: '',
    children: [],
    parentElement: null,
    id: '',
    textContent: '',
    value: '',
    checked: false,
    files: [],
    removed: false,
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    remove() {
      this.removed = true;
      if (this.parentElement) this.parentElement.removeChild(this);
      this.parentElement = null;
    },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    click() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; },
    cloneNode() { return makeEl(this.tagName, created); },
    getBoundingClientRect() { return { width: 100, height: 50, top: 0, left: 0, right: 100, bottom: 50 }; },
    getContext() {
      return {
        font: '20px sans-serif', textBaseline: 'top', textAlign: 'left', fillStyle: '#000',
        clearRect() {}, fillText() {}, measureText() { return { width: 10 }; },
        getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
      };
    },
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    // 面板 refresh 每次都会先清空 body，mock 里必须真的清空，否则同一个元素会无限堆积
    set(v) { html = String(v); if (html === '') el.children = []; },
  });
  if (created) created.push(el);
  return el;
}

function makeVideo(documentEl) {
  const v = {
    tagName: 'VIDEO', nodeType: 1, isConnected: true,
    paused: false, ended: false, duration: 600, currentTime: 120,
    playbackRate: 1, muted: false, volume: 1,
    src: 'http://mock.local/lesson.webm', currentSrc: 'http://mock.local/lesson.webm',
    style: { cssText: '' },
    ownerDocument: documentEl,
    __cxasBound: false,
    pauseCalls: 0, playCalls: 0,
    pause() { this.paused = true; this.pauseCalls++; },
    play() { this.paused = false; this.playCalls++; return Promise.resolve(); },
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect() { return { width: 640, height: 360, top: 0, left: 0 }; },
    closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
  return v;
}

/*
 * 启动一份脚本实例（每个实例 = 一次"页面加载"）。
 * opts:
 *   cfg        —— 预置到 GM 存储的配置
 *   withVideo  —— 放一个可见的 <video>，用于测播放相关逻辑
 *   quizBox    —— 提供一个可见弹题盒子，用于测"弹题优先"
 */
function boot(opts) {
  opts = opts || {};
  const created = [];
  const bodyEl = makeEl('body', created);
  const videoEl = opts.withVideo ? makeVideo(null) : null;

  const quizBox = opts.quizBox ? (() => {
    const q = makeEl('div', created);
    q.textContent = '弹题：以下描述正确的是';
    q.__visible = true;      // 测试可翻转：模拟"暂停恢复后才弹题"的时序
    return q;
  })() : null;

  // vjs 大播放按钮：恢复校验兜底分支要验证"真的点了它"，所以记录点击次数
  const playBtn = makeEl('button', created);
  playBtn.className = 'vjs-big-play-button';
  playBtn.clicks = 0;
  playBtn.click = () => { playBtn.clicks += 1; };

  const documentEl = {
    nodeType: 9,
    body: bodyEl,
    head: makeEl('head', created),
    documentElement: makeEl('html', created),
    title: '',
    fonts: { add() {}, ready: Promise.resolve() },
    styleSheets: [],
    createElement: (t) => makeEl(t, created),
    getElementById() { return null; },
    querySelector(sel) {
      if (/vjs-big-play-button/.test(String(sel))) return playBtn;
      if (quizBox && quizBox.__visible !== false && /ans-videoquiz|videoquiz/.test(String(sel))) return quizBox;
      return null;
    },
    querySelectorAll(sel) {
      if (videoEl && String(sel) === 'video') return [videoEl];
      return [];
    },
    addEventListener() {}, removeEventListener() {},
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  };
  if (videoEl) videoEl.ownerDocument = documentEl;

  const intervals = [];
  const windowEl = {
    document: documentEl,
    location: {
      hostname: 'mooc1.chaoxing.com',
      host: 'mooc1.chaoxing.com',
      pathname: '/mycourse/studentstudy',
      href: 'https://mooc1.chaoxing.com/mycourse/studentstudy?x=1',
      search: '?x=1',
    },
    self: null, top: null, frames: [],
    history: { length: 2, back() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    addEventListener() {}, removeEventListener() {},
    postMessage() {}, confirm: () => true, prompt: () => '',
    FontFace: class { constructor(f, s) { this.family = f; this.source = s; } load() { return Promise.resolve(this); } },
    setTimeout: (fn, ms) => setTimeout(fn, 0),
    setInterval: (fn, ms) => { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    MutationObserver: class { observe() {} disconnect() {} },
    Blob: class { constructor() {} },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    localStorage: {
      _d: {},
      getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
      key(i) { return Object.keys(this._d)[i] || null; },
      get length() { return Object.keys(this._d).length; },
    },
    sessionStorage: {
      _d: {},
      getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
    },
    console: { log() {}, warn() {}, error() {} },
  };
  windowEl.self = windowEl;
  windowEl.top = windowEl;

  const sandbox = {
    window: windowEl, document: documentEl, unsafeWindow: windowEl, location: windowEl.location,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => setTimeout(fn, 0), setInterval: (fn, ms) => { intervals.push(fn); return intervals.length; },
    clearTimeout: () => {}, clearInterval() {},
    MutationObserver: windowEl.MutationObserver, Blob: windowEl.Blob, URL: windowEl.URL,
    localStorage: windowEl.localStorage, sessionStorage: windowEl.sessionStorage,
    fetch: () => Promise.resolve({ text: () => Promise.resolve(''), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
    GM_getValue: (k, d) => {
      if (k === 'cfg') return Object.assign({ verbose: true }, opts.cfg || {});
      return k in sandbox.__gm ? sandbox.__gm[k] : d;
    },
    GM_setValue: (k, v) => { sandbox.__gm[k] = v; },
    GM_xmlhttpRequest: (o) => { if (o && o.onerror) setTimeout(() => o.onerror(), 0); },
    __gm: {},
  };
  sandbox.globalThis = sandbox;
  sandbox.self = windowEl;

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'user.js', timeout: 15000 });

  const dbg = windowEl.__CXAS_DEBUG;
  if (!dbg) throw new Error('未取到调试钩子：verbose 配置未生效？');

  return {
    dbg, sandbox, created, bodyEl, videoEl, quizBox, playBtn, intervals,
    panel: () => dbg.hud(),
    lines() {
      const panel = dbg.hud();
      if (!panel) return [];
      const body = panel.children[1]; // createHud 的追加顺序：title, body, row1..row5, input
      if (!body) return [];
      return body.children.map((c) => String(c.textContent || ''));
    },
    text() {
      const panel = dbg.hud();
      return panel ? String(panel.textContent || '') : '';
    },
    tick() { dbg.tickVideo(); },
  };
}

function numFrom(css, re) {
  const m = String(css || '').match(re);
  return m ? Number(m[1]) : NaN;
}

console.log('[1] 面板 / 徽标 DOM 指纹随机化');
const a = boot({ cfg: {} });
const b = boot({ cfg: {} });
const fpA = a.dbg.fingerprint;
const fpB = b.dbg.fingerprint;

ok('面板已创建并挂到 body', !!a.panel() && a.bodyEl.children.indexOf(a.panel()) >= 0);
ok('面板 id 形如随机小写串', /^[a-z]{8,}$/.test(a.panel().id), a.panel().id);
ok('面板 id 每次加载不同', fpA.ids.hud !== fpB.ids.hud, fpA.ids.hud + ' vs ' + fpB.ids.hud);
ok('面板 class 每次加载不同', fpA.cls.hud !== fpB.cls.hud, fpA.cls.hud + ' vs ' + fpB.cls.hud);
ok('面板 id 不是固定字符串 cxas-hud', fpA.ids.hud !== 'cxas-hud' && fpB.ids.hud !== 'cxas-hud');
ok('内部 class 全部随机且互不相同',
  new Set(Object.values(fpA.cls)).size === Object.keys(fpA.cls).length &&
  Object.values(fpA.cls).every((c) => /^[a-z]{6,}$/.test(c)),
  Object.values(fpA.cls).join(','));
ok('按钮带随机 class', a.created.filter((e) => e.className === fpA.cls.btn).length >= 14,
  a.created.filter((e) => e.className === fpA.cls.btn).length + ' 个');
ok('行容器带随机 class', a.created.filter((e) => e.className === fpA.cls.row).length === 5);

// 全树扫描：任何固定 id / class / data-* 特征都不该出现
const suspicious = a.created.filter((e) => {
  const id = String(e.id || '');
  const cls = String(e.className || '');
  if (/cxas/i.test(id) || /cxas/i.test(cls)) return true;
  if (id === 'cxas-hud' || id === 'cxas-debug-badge') return true;
  return Object.keys(e.dataset || {}).length > 0;
});
ok('DOM 里没有 cxas 固定 id/class、也没有 data-* 指纹', suspicious.length === 0,
  suspicious.map((e) => e.id || e.className).join(','));

// cssText 数值微扰：落在合理区间，且两次加载不能完全一样
const cssA = a.panel().style.cssText;
const cssB = b.panel().style.cssText;
const mA = {
  right: numFrom(cssA, /right:([\d.]+)px/),
  width: numFrom(cssA, /width:([\d.]+)px/),
  padY: numFrom(cssA, /padding:([\d.]+)px [\d.]+px/),
  padX: numFrom(cssA, /padding:[\d.]+px ([\d.]+)px/),
};
ok('位置/宽度/内边距仍在合理区间',
  mA.right >= 11 && mA.right <= 21 && mA.width >= 242 && mA.width <= 258 &&
  mA.padY >= 8 && mA.padY <= 12 && mA.padX >= 10 && mA.padX <= 14,
  JSON.stringify(mA));
const mB = {
  right: numFrom(cssB, /right:([\d.]+)px/),
  width: numFrom(cssB, /width:([\d.]+)px/),
  padY: numFrom(cssB, /padding:([\d.]+)px [\d.]+px/),
  padX: numFrom(cssB, /padding:[\d.]+px ([\d.]+)px/),
};
ok('两次加载的 style 数值不完全相同（特征匹配失效）',
  Object.keys(mA).some((k) => mA[k] !== mB[k]), JSON.stringify(mA) + ' vs ' + JSON.stringify(mB));

console.log('\n[2] 调试徽标同样随机化（默认关闭，开启也不能有固定 id）');
const d1 = boot({ cfg: { debugBadge: true } });
const d2 = boot({ cfg: { debugBadge: true } });
const badge1 = d1.created.find((e) => /已注入/.test(String(e.textContent || '')));
const badge2 = d2.created.find((e) => /已注入/.test(String(e.textContent || '')));
ok('徽标已创建', !!badge1 && !!badge2);
ok('徽标 id 随机且每次不同',
  !!badge1 && !!badge2 && /^[a-z]{8,}$/.test(badge1.id) && badge1.id !== badge2.id &&
  badge1.id !== 'cxas-debug-badge',
  (badge1 && badge1.id) + ' vs ' + (badge2 && badge2.id));
ok('面板创建后徽标被移除（内部引用清理）', d1.dbg.debugBadge() === null && badge1.removed === true);

console.log('\n[3] 作息时段解析（含跨午夜）');
eq('7-23 解析', a.dbg.parseActiveHours('7-23'), { start: 7, end: 23 });
eq('22-6 解析（跨午夜）', a.dbg.parseActiveHours('22-6'), { start: 22, end: 6 });
eq('7:30-23:00 解析', a.dbg.parseActiveHours('7:30-23:00'), { start: 7.5, end: 23 });
eq('对象写法', a.dbg.parseActiveHours({ start: 9, end: 12 }), { start: 9, end: 12 });
eq('空串 = 全天', a.dbg.parseActiveHours(''), null);
eq('null = 全天', a.dbg.parseActiveHours(null), null);
eq('写错 = 回退全天（不静默停摆）', a.dbg.parseActiveHours('熬夜'), null);
eq('0-24 等价全天', a.dbg.parseActiveHours('0-24'), null);

const D = (h, m) => new Date(2026, 0, 1, h, m || 0, 0);
const R723 = a.dbg.parseActiveHours('7-23');
const R226 = a.dbg.parseActiveHours('22-6');
eq('7-23 @07:00 允许', a.dbg.inActiveHours(R723, D(7, 0)), true);
eq('7-23 @22:59 允许', a.dbg.inActiveHours(R723, D(22, 59)), true);
eq('7-23 @23:00 禁止', a.dbg.inActiveHours(R723, D(23, 0)), false);
eq('7-23 @03:00 禁止', a.dbg.inActiveHours(R723, D(3, 0)), false);
eq('22-6 @23:00 允许', a.dbg.inActiveHours(R226, D(23, 0)), true);
eq('22-6 @05:59 允许', a.dbg.inActiveHours(R226, D(5, 59)), true);
eq('22-6 @06:00 禁止', a.dbg.inActiveHours(R226, D(6, 0)), false);
eq('22-6 @12:00 禁止', a.dbg.inActiveHours(R226, D(12, 0)), false);
eq('未配置 = 全天允许', a.dbg.inActiveHours(null, D(3, 0)), true);

console.log('\n[4] 时段外：暂停播放 + 面板可见原因');
// 用当前时间反推一个必然"不在时段"的窗口（例：现在 23 点 → '0-1'）
const nowH = new Date().getHours();
const outRange = ((nowH + 1) % 24) + '-' + ((nowH + 2) % 24);
const off = boot({ cfg: { activeHours: outRange }, withVideo: true });
off.tick();
ok('时段外视频被暂停', off.videoEl.paused === true && off.videoEl.pauseCalls >= 1,
  'range=' + outRange + ' pauseCalls=' + off.videoEl.pauseCalls);
ok('lastAction 说明原因', /不在作息时段/.test(off.dbg.stats.lastAction), off.dbg.stats.lastAction);
ok('面板显示"外（已暂停播放）"',
  off.lines().some((l) => l.indexOf('作息时段：') === 0 && /外（已暂停播放）/.test(l)),
  off.lines().find((l) => l.indexOf('作息时段：') === 0));
ok('时段外不触发自动播放', off.videoEl.playCalls === 0, 'playCalls=' + off.videoEl.playCalls);

const badCfg = boot({ cfg: { activeHours: '熬夜' } });
ok('配置写错时面板给出原因（而不是静默）',
  badCfg.lines().some((l) => /配置无法解析/.test(l)),
  badCfg.lines().find((l) => l.indexOf('作息时段：') === 0));

console.log('\n[5] 拟人化随机暂停：暂停 → 恢复，且不与 autoPlay 打架');
const hz = boot({
  cfg: {
    activeHours: '',            // 全天，排除时段干扰
    humanize: true,
    humanizePauseChance: 0.05,  // 配置上限 0.05：平均 20 tick 内必触发
    humanizePauseMin: 1,
    humanizePauseMax: 1,
  },
  withVideo: true,
});
// 概率触发是随机的，用有限次 tick 收敛（0.95^500 的漏触发概率可忽略），保证测试不抖
for (let i = 0; i < 500 && !hz.dbg.humanize.pausing; i++) hz.tick();
ok('随机暂停已触发', hz.dbg.humanize.pausing === true && hz.videoEl.paused === true,
  'pauseCalls=' + hz.videoEl.pauseCalls);
ok('内部标记区分"自己暂停"', hz.dbg.humanize.pausedByMe === true);
ok('面板状态显示"暂停中"', /暂停中/.test(hz.dbg.stats.humanize), hz.dbg.stats.humanize);
ok('lastAction 写明"拟人化暂停中"', /拟人化暂停中/.test(hz.dbg.stats.lastAction), hz.dbg.stats.lastAction);
hz.intervals.forEach((fn) => fn());   // 跑一轮 mainTick 让面板按当前状态重绘后再断言文案
ok('面板同时显示总开关与随机暂停状态',
  hz.lines().some((l) => /^拟人化：开 ｜ 随机暂停：暂停中/.test(l)),
  hz.lines().find((l) => l.indexOf('拟人化：') === 0));

hz.tick();
ok('暂停期内 autoPlay 不掀掉自己的暂停', hz.videoEl.paused === true && hz.videoEl.playCalls === 0,
  'playCalls=' + hz.videoEl.playCalls);

// 等暂停窗口过去，下一 tick 应自动恢复播放
const resume = new Promise((resolve) => setTimeout(resolve, 1200)).then(() => {
  hz.tick();
  ok('暂停结束后自动恢复播放', hz.videoEl.paused === false && hz.videoEl.playCalls >= 1,
    'playCalls=' + hz.videoEl.playCalls);
  ok('恢复后内部标记已清空', hz.dbg.humanize.pausing === false);
  ok('lastAction 说明恢复',
    /继续播放/.test(hz.dbg.stats.lastAction), hz.dbg.stats.lastAction);
  return null;
});

resume.then(async () => {
  console.log('\n[6] 弹题优先：平台暂停时拟人化不得抢控制权');
  const qz = boot({
    cfg: { activeHours: '', humanize: true, humanizePauseChance: 0 },
    withVideo: true,
    quizBox: true,
  });
  qz.dbg.humanize.start(qz.videoEl);   // 手动进入拟人化暂停
  ok('已进入拟人化暂停', qz.dbg.humanize.pausing === true && qz.videoEl.paused === true);
  qz.tick();                            // 此时有弹题 → 拟人化让位
  ok('弹题出现后拟人化暂停让位', qz.dbg.humanize.pausing === false);
  ok('让位不会擅自播放（弹题期间保持暂停）', qz.videoEl.paused === true && qz.videoEl.playCalls === 0,
    'playCalls=' + qz.videoEl.playCalls);
  ok('lastAction 记录让位原因', /弹题优先/.test(qz.dbg.stats.lastAction), qz.dbg.stats.lastAction);

  console.log('\n[7] 拟人化参数兜底（写错配置不能让脚本卡死）');
  const clamp = boot({ cfg: { humanizePauseChance: 99, humanizePauseMin: 0, humanizePauseMax: -5 } });
  eq('概率夹到 0.05 上限', clamp.dbg.cfg.humanizePauseChance, 0.05);
  eq('最短暂停非法值(0)回退默认 3 秒', clamp.dbg.cfg.humanizePauseMin, 3);
  eq('最长小于最短时抬到最短', clamp.dbg.cfg.humanizePauseMax, 3);
  const clamp2 = boot({ cfg: { humanizePauseMin: 'abc', humanizePauseMax: '' } });
  eq('非数字最短回退 3 秒', clamp2.dbg.cfg.humanizePauseMin, 3);
  eq('空最长回退 15 秒', clamp2.dbg.cfg.humanizePauseMax, 15);

  console.log('\n[8] humanize 总开关必须能关掉作息时段闸门（F1）');
  // 需求原文：humanize 是"随机暂停 + 作息时段限制"的总开关，
  // 所以 humanize:false 时即使配了 activeHours 也不能停播（否则"拟人化：关 + 因时段暂停"同屏矛盾）。
  const offSwitch = boot({ cfg: { humanize: false, activeHours: outRange }, withVideo: true });
  offSwitch.tick();
  ok('humanize:false 时时段外不暂停视频',
    offSwitch.videoEl.paused === false && offSwitch.videoEl.pauseCalls === 0,
    'paused=' + offSwitch.videoEl.paused + ' pauseCalls=' + offSwitch.videoEl.pauseCalls);
  ok('humanize:false 时面板不出现"外（已暂停播放）"',
    !offSwitch.lines().some((l) => /外（已暂停播放）/.test(l)),
    offSwitch.lines().find((l) => l.indexOf('作息时段：') === 0));
  ok('面板说明时段配置存在但未生效',
    offSwitch.lines().some((l) => l.indexOf('作息时段：') === 0 && /humanize 已关，未生效/.test(l)),
    offSwitch.lines().find((l) => l.indexOf('作息时段：') === 0));

  console.log('\n[9] 时段外 lastAction 不被每 tick 覆盖（F2）');
  // mainTick 顺序是 tickVideo → tickQuiz → tickWork；修前 tickQuiz 的"已跳过弹题作答"
  // 会把主因"已暂停播放"每 tick 吃掉，面板只剩次要信息。
  const keepMsg = boot({ cfg: { activeHours: outRange, humanize: true }, withVideo: true, quizBox: true });
  keepMsg.tick();
  const firstMsg = keepMsg.dbg.stats.lastAction;
  ok('首帧写的是主因（已暂停播放）', /已暂停播放/.test(firstMsg), firstMsg);
  keepMsg.intervals.forEach((fn) => fn());          // 完整跑一轮 mainTick
  const secondMsg = keepMsg.dbg.stats.lastAction;
  ok('跑过主循环后主因仍在，不被"已跳过弹题"覆盖',
    /已暂停播放/.test(secondMsg) && !/已跳过弹题作答/.test(secondMsg), secondMsg);
  keepMsg.intervals.forEach((fn) => fn());
  keepMsg.intervals.forEach((fn) => fn());
  ok('连续多 tick 后仍是同一条主因（不抖动）',
    keepMsg.dbg.stats.lastAction === secondMsg, keepMsg.dbg.stats.lastAction);

  console.log('\n[10] 拆分开关：humanizePause 可单独关，时段保护保留（t15/A）');
  // 只关随机暂停，作息时段必须继续生效
  const onlyHours = boot({ cfg: { humanize: true, humanizePause: false, activeHours: outRange }, withVideo: true });
  onlyHours.tick();
  ok('humanizePause:false 时时段外仍暂停（保护保留）',
    onlyHours.videoEl.paused === true && onlyHours.videoEl.pauseCalls >= 1,
    'paused=' + onlyHours.videoEl.paused + ' pauseCalls=' + onlyHours.videoEl.pauseCalls);
  ok('面板同时显示 拟人化：开 ｜ 随机暂停：关',
    onlyHours.lines().some((l) => /^拟人化：开 ｜ 随机暂停：关$/.test(l)),
    onlyHours.lines().find((l) => l.indexOf('拟人化：') === 0));

  // 只关随机暂停：即使概率拉满也不该暂停
  const noPause = boot({
    cfg: { humanize: true, humanizePause: false, activeHours: '', humanizePauseChance: 0.05 },
    withVideo: true,
  });
  for (let i = 0; i < 500; i++) noPause.tick();
  ok('humanizePause:false 时概率拉满也不随机暂停',
    noPause.videoEl.pauseCalls === 0, 'pauseCalls=' + noPause.videoEl.pauseCalls);
  ok('面板台账显示"未启用"（随机暂停关闭）',
    noPause.lines().some((l) => /^拟人化暂停：未启用$/.test(l)),
    noPause.lines().find((l) => l.indexOf('拟人化暂停：') === 0));

  // 总开关语义不变：humanize:false 两个都关
  const master = boot({ cfg: { humanize: false, humanizePause: true, activeHours: outRange }, withVideo: true });
  master.tick();
  ok('humanize:false 时时段也不再生效（总开关语义不变）',
    master.videoEl.pauseCalls === 0, 'pauseCalls=' + master.videoEl.pauseCalls);
  ok('面板显示 拟人化：关 ｜ 随机暂停：关',
    master.lines().some((l) => /^拟人化：关 ｜ 随机暂停：关$/.test(l)),
    master.lines().find((l) => l.indexOf('拟人化：') === 0));

  console.log('\n[11] 暂停占比硬闸门 humanizePauseBudget（t15/B1）');
  const A = hz.dbg.humanize.budgetAllows;
  eq('已用 4.9s + 计划 1s 超过 5% 上限 → 拒绝', A(100, 4.9, 1, 0.05), false);
  eq('已用 3s + 计划 1s 未超上限 → 允许', A(100, 3, 1, 0.05), true);
  eq('已播 0 秒 → 不允许任何暂停', A(0, 0, 3, 0.05), false);
  eq('budget=0 → 永不暂停', A(1000, 0, 3, 0), false);
  // 集成：视频只到 120s、budget 0.5% → 上限 0.6s，计划 1s 必被拒
  const strict = boot({
    cfg: {
      activeHours: '', humanize: true, humanizePauseChance: 0.05,
      humanizePauseMin: 1, humanizePauseMax: 1,
      humanizePauseBudget: 0.005, humanizeMinGapSec: 0,
    },
    withVideo: true,
  });
  for (let i = 0; i < 500; i++) strict.tick();
  ok('占比不够时 500 tick 也不暂停', strict.videoEl.pauseCalls === 0,
    'pauseCalls=' + strict.videoEl.pauseCalls + ' ledger=' + JSON.stringify(strict.dbg.humanize.ledger));

  console.log('\n[12] 最小间隔 humanizeMinGapSec（t15/B2）');
  const gap = boot({
    cfg: {
      activeHours: '', humanize: true, humanizePauseChance: 0.05,
      humanizePauseMin: 1, humanizePauseMax: 1,
      humanizeMinGapSec: 180, humanizePauseBudget: 0.5,
    },
    withVideo: true,
  });
  for (let i = 0; i < 500 && !gap.dbg.humanize.pausing; i++) gap.tick();
  ok('第一次暂停已触发', gap.dbg.humanize.pausing === true,
    'pauseCalls=' + gap.videoEl.pauseCalls);
  await sleep(1100);
  gap.tick();                                  // 暂停到期 → 恢复
  ok('暂停已恢复', gap.dbg.humanize.pausing === false && gap.videoEl.paused === false);
  for (let i = 0; i < 500; i++) gap.tick();    // 间隔不足 180s，概率拉满也不该再停
  ok('间隔 <180s 时不触发第二次暂停', gap.dbg.humanize.ledger.pauseCount === 1,
    'pauseCount=' + gap.dbg.humanize.ledger.pauseCount);

  console.log('\n[13] 恢复校验：currentTime 不推进 → 点 .vjs-big-play-button 兜底（t15/B3）');
  const rv = boot({
    cfg: {
      activeHours: '', humanize: true, humanizePauseChance: 0.05,
      humanizePauseMin: 1, humanizePauseMax: 1,
      humanizeMinGapSec: 0, humanizePauseBudget: 0.5,
      humanizeResumeCheckMs: 200,
    },
    withVideo: true,
  });
  for (let i = 0; i < 500 && !rv.dbg.humanize.pausing; i++) rv.tick();
  ok('触发暂停', rv.dbg.humanize.pausing === true);
  // t18/F1'：必须关掉后续骰子。否则"暂停到期"的同一个 tick 里还有 5% 概率立刻开一个新暂停，
  // 新暂停会把 resumeCheck 置 null、stats.humanize 变回"暂停中"，让本组断言周期性假红。
  // 产品默认 humanizeMinGapSec=180 下不可能发生，这是测试场景缺陷。
  rv.dbg.cfg.humanizePauseChance = 0;
  const resumed = await tickUntil(
    rv,
    () => rv.dbg.humanize.pausing === false && rv.videoEl.paused === false,
    3000
  );                                           // 暂停到期 → play()，但 mock 的 currentTime 不动
  ok('已尝试恢复播放（play 被调用）', resumed && rv.videoEl.playCalls >= 1,
    'playCalls=' + rv.videoEl.playCalls);
  // 注意：autoPlay 恢复时本身也会点一次播放按钮（既有行为），所以兜底点击要按"增量"断言
  const clicksAtResume = rv.playBtn.clicks;
  const fellBack = await tickUntil(rv, () => rv.playBtn.clicks > clicksAtResume, 3000);
  ok('进度未推进 → 点了 .vjs-big-play-button 兜底', fellBack && rv.playBtn.clicks === clicksAtResume + 1,
    'clicks=' + rv.playBtn.clicks + '（恢复时已点 ' + clicksAtResume + ' 次）');
  ok('lastAction 记录兜底动作', /播放按钮/.test(rv.dbg.stats.lastAction), rv.dbg.stats.lastAction);
  const failed = await tickUntil(rv, () => rv.dbg.humanize.resumeFailed === true, 3000);
  ok('仍不推进 → 标记恢复失败且不无限重试',
    failed && rv.playBtn.clicks === clicksAtResume + 1,
    'resumeFailed=' + rv.dbg.humanize.resumeFailed + ' clicks=' + rv.playBtn.clicks);
  // stats.humanize 在"判定失败"的下一拍才会带上失败状态，轮询到为止
  await tickUntil(rv, () => /恢复失败/.test(rv.dbg.stats.humanize), 1500);
  ok('面板显示恢复失败', /恢复失败/.test(rv.dbg.stats.humanize), rv.dbg.stats.humanize);
  for (let i = 0; i < 5; i++) rv.tick();
  ok('后续 tick 不再重复点按钮', rv.playBtn.clicks === clicksAtResume + 1,
    'clicks=' + rv.playBtn.clicks);

  console.log('\n[13b] 恢复校验窗口内出现弹题：不得在弹题遮罩下拉起视频（t18/F2\'）');
  const rq = boot({
    cfg: {
      activeHours: '', humanize: true, humanizePauseChance: 0.05,
      humanizePauseMin: 1, humanizePauseMax: 1,
      humanizeMinGapSec: 0, humanizePauseBudget: 0.5,
      humanizeResumeCheckMs: 400,     // 留出"弹题插进窗口"的时间
    },
    withVideo: true,
    quizBox: true,
  });
  rq.quizBox.__visible = false;               // 初始没有弹题，才能触发随机暂停
  for (let i = 0; i < 500 && !rq.dbg.humanize.pausing; i++) rq.tick();
  ok('先正常触发暂停', rq.dbg.humanize.pausing === true);
  rq.dbg.cfg.humanizePauseChance = 0;
  const rqResumed = await tickUntil(
    rq,
    () => rq.dbg.humanize.pausing === false && rq.videoEl.paused === false,
    3000
  );
  ok('暂停已恢复（进入恢复校验窗口）', rqResumed === true);
  const clicksBeforeQuiz = rq.playBtn.clicks;
  rq.quizBox.__visible = true;                // 校验窗口内弹题出现
  await sleep(450);                           // 跨过 humanizeResumeCheckMs
  rq.tick();
  ok('弹题出现时不点播放按钮兜底', rq.playBtn.clicks === clicksBeforeQuiz,
    'clicks=' + rq.playBtn.clicks + '（弹题前 ' + clicksBeforeQuiz + '）');
  for (let i = 0; i < 4; i++) rq.tick();
  ok('弹题期间也不会被误判为恢复失败',
    rq.dbg.humanize.resumeFailed === false && rq.playBtn.clicks === clicksBeforeQuiz,
    'resumeFailed=' + rq.dbg.humanize.resumeFailed + ' clicks=' + rq.playBtn.clicks);

  console.log('\n[14] 台账可观测：面板显示已用/上限/占比/次数（t15/B5）');
  hz.intervals.forEach((fn) => fn());           // 跑一轮 mainTick 刷新面板
  const usageLine = hz.lines().find((l) => l.indexOf('拟人化暂停：') === 0);
  ok('面板台账格式正确',
    /^拟人化暂停：已用 \d+\/\d+ 秒（\d+%）· 共 1 次$/.test(usageLine || ''), usageLine);
  ok('台账累计了暂停时长与次数',
    hz.dbg.humanize.ledger.pauseCount === 1 && hz.dbg.humanize.ledger.pausedMs >= 900,
    JSON.stringify(hz.dbg.humanize.ledger));

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.log('FAIL 异常：' + (e && e.stack || e));
  process.exit(1);
});
