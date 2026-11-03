// v4.0 新功能单测：抖动自检熔断（noteFlapEvent）+ 音频任务点（tickAudio）+ 任务点诊断（tickDoc / tickDiag）
// 运行：node tests/v4-core.test.js
//
// 为什么单测：
//   ① 抖动熔断是"防自己被风控"的最后一道闸。它自己坏了不会报错——只会在真实页面上继续
//      每秒抢控制权，而这恰恰最难人工发现（人不在电脑前时最需要它）。
//   ② 音频任务点只在部分章节出现，"未播 / 播完 / 自动播放被拦"三种状态在真页面上很难稳定复现；
//      限频一旦失效就会退化成每 tick play()，退回到 3.2.2 已经踩过的风控坑。
//   ③ 诊断字段是给下一次在真实测验页定位问题用的：字段名写错/写成 undefined 不会报错，
//      只会在面板上显示空白，等于白做。
//   ④ [11]-[14] 是 2026-11 因本套测试发现的问题而新增的回归断言（总开关门禁、音频事件计入熔断、
//      多音频选择与完成态过滤）。这四条都可能被"顺手重构"改回去，而回退后完全不会报错，
//      只会表现为"暂停了还在播音频""已完成任务点被反复拉起"这类只能在真页面上偶然察觉的现象。
//
// 被测函数通过 window.__CXAS_DEBUG 暴露（脚本以 CFG.verbose=true 启动时才挂载）。
// 启动套路与 tests/doc-face.test.js / tests/resume-chain.test.js 一致：vm + 假 window/document。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'xuexitong-assistant.user.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}

function makeEl(tag, classes) {
  const el = {
    tagName: (tag || 'div').toUpperCase(), nodeType: 1,
    style: { cssText: '' }, children: [], parentElement: null,
    id: '', className: (classes || []).join(' '),
    textContent: '', value: '', checked: false, files: [],
    classList: {
      _s: new Set(classes || []),
      contains(c) { return this._s.has(c); },
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
    },
    _map: {},
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    remove() {}, setAttribute() {}, getAttribute() { return null; },
    /* 记录监听器：v4.0 把音频的 play/pause 也接进了抖动熔断，测试需要
     * ① 证明监听器确实注册到了 audio 上 ② 手动把事件打进去，看计数真的会涨。 */
    _listeners: {},
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const l = this._listeners[type];
      if (l) this._listeners[type] = l.filter((x) => x !== fn);
    },
    dispatchEvent(ev) {
      const l = (this._listeners[(ev && ev.type) || ''] || []).slice();
      for (const fn of l) { try { fn(ev); } catch (e) { /* 忽略 */ } }
      return l.length > 0;
    },
    click() { this.clicked = (this.clicked || 0) + 1; },
    querySelector(s) { const v = this._map[s]; return v === undefined ? null : v; },
    querySelectorAll(s) {
      const v = this._map[s];
      if (v === undefined) return [];
      return Array.isArray(v) ? v : [v];
    },
    closest() { return null; }, cloneNode() { return makeEl(this.tagName); },
    getBoundingClientRect() { return { width: 100, height: 50, top: 0, left: 0 }; },
    getContext() {
      return {
        font: '', textBaseline: '', textAlign: '', fillStyle: '',
        clearRect() {}, fillText() {}, measureText() { return { width: 10 }; },
        getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
      };
    },
  };
  return el;
}

/* 把事件真的派发进去（而不是直接调 noteFlapEvent）：只有这样才能证明
 * 「音频的 play/pause 事件确实接到了熔断计数器上」——直接调函数是假阳性。 */
function fire(el, type, times) {
  const n = times === undefined ? 1 : times;
  let calls = 0;
  for (let i = 0; i < n; i++) {
    const l = (el._listeners[type] || []).slice();
    calls += l.length;
    el.dispatchEvent({ type: type, target: el });
  }
  return calls;
}

/* 假 <audio>：
 *   o.autoplayBlocked = true → play() 只记录次数、**不改 paused**，模拟浏览器拦下自动播放。
 *   这正是"限频"必须存在的场景：状态没变，所以下一次 tick 还会想再 play()。 */
function makeAudio(opts) {
  const o = opts || {};
  const a = makeEl('audio');
  a.tagName = 'AUDIO';
  a.isConnected = o.connected !== false;
  a.paused = o.paused !== false;          // 默认"还没开始播"
  a.ended = !!o.ended;
  a.currentTime = o.currentTime || 0;
  a.duration = o.duration === undefined ? 300 : o.duration;
  a.muted = false;
  a.volume = 1;
  a.plays = 0;
  a.play = function () {
    a.plays++;
    if (!o.autoplayBlocked) a.paused = false;   // 正常放行：状态立刻变成"播放中"
    return Promise.resolve();
  };
  a.pause = function () { a.paused = true; };
  /* 任务点容器：tickAudio 用 closest('.ans-attach-ct') 判断"这个音频属于哪个任务点"，
   * 再按容器里 .ans-job-icon 有没有 -clear 判断是否已完成。没有容器时返回 null（不过滤）。 */
  a._closest = o.closest || null;
  a.closest = function () { return a._closest; };
  a.getBoundingClientRect = function () {
    return {
      width: o.width === undefined ? 320 : o.width,
      height: o.height === undefined ? 54 : o.height,
      top: 0, left: 0,
    };
  };
  return a;
}

/* opts:
 *   cfg         覆盖 GM 里存的 cfg（verbose 强制 true，否则拿不到调试钩子）
 *   docTask     顶层放一个未完成的文档任务点容器（.ans-job-icon.ans-job-icon-clear + iframe）
 *   audio       单个假 audio 的配置；null = 没有音频
 *   audios      多个假 audio 的配置数组（优先于 audio），用于测多任务点选择
 *   audioWhere  'iframe'（默认，考跨同源 iframe）/ 'top'
 *   cardsDoc    iframe 的 location.href 命中 knowledge/cards（tickDiag 只认这个文档）
 *   jobIcons    cards 文档里的任务点图标 className 数组
 *   questionCount cards 文档里的题目数
 */
function boot(opts) {
  const o = opts || {};
  const stored = Object.assign({ verbose: true }, o.cfg || {});

  const bodyEl = makeEl('body');

  const innerScroller = makeEl('div');
  innerScroller.scrollTop = 0;
  innerScroller.scrollHeight = 3000;
  innerScroller.clientHeight = 600;

  const jobIcons = (o.jobIcons || []).map((cls) => makeEl('span', String(cls).split(/\s+/).filter(Boolean)));
  const questions = [];
  for (let i = 0; i < (o.questionCount || 0); i++) questions.push(makeEl('div', ['TiMu']));

  /* 音频可以给 1 个（audio）或 N 个（audios）。每个都能选择落在哪个任务点容器里：
   *   finishedBox: true  → 容器图标**没有** -clear（已完成，不该再被驱动）
   *   finishedBox: false → 容器图标带 -clear（未完成）
   * 不给 finishedBox 且元素没有 .ans-attach-ct 祖先时 closest() 返回 null，不做完成态过滤。 */
  const audioOpts = o.audios || (o.audio ? [o.audio] : []);
  const audioEls = audioOpts.map((cfg) => makeAudio(cfg));
  const audioInIframe = o.audioWhere !== 'top';

  /* iframe 内层文档：文档任务点的滚动正文、音频任务点的 <audio>、诊断用的 cards 文档 */
  const innerDoc = {
    nodeType: 9, body: makeEl('body'), documentElement: makeEl('html'), title: '',
    location: {
      href: o.cardsDoc
        ? 'https://mooc1.chaoxing.com/knowledge/cards?clazzid=1&courseid=2'
        : 'https://mooc1.chaoxing.com/ananas/modules/doc/index.html',
    },
    scrollingElement: innerScroller,
    createElement: (t) => makeEl(t),
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll(s) {
      if (s === 'audio') return audioInIframe ? audioEls : [];
      if (s === 'iframe') return [];
      if (s === '.ans-job-icon') return jobIcons;
      if (s === '.TiMu, .questionLi, .ans-videoquiz, .TiMuNew') return questions;
      return [];
    },
    addEventListener() {}, styleSheets: [],
    fonts: { add() {}, ready: Promise.resolve() },
  };

  const frame = makeEl('iframe');
  frame.contentDocument = innerDoc;

  const attachBoxes = [];
  if (o.docTask) {
    const icon = makeEl('span', ['ans-job-icon', 'ans-job-doc', 'ans-job-icon-clear']);   // 带 -clear = 未完成
    const box = makeEl('div', ['ans-attach-ct']);
    box._map['.ans-job-icon'] = icon;
    box._map['iframe'] = frame;
    box.scrollHeight = 0;
    box.clientHeight = 0;
    attachBoxes.push(box);
  }

  const documentEl = {
    nodeType: 9, body: bodyEl, head: makeEl('head'), documentElement: makeEl('html'), title: '',
    fonts: { add() {}, ready: Promise.resolve() }, styleSheets: [],
    createElement: (t) => makeEl(t),
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll(s) {
      if (s === '.ans-attach-ct') return attachBoxes;
      if (s === 'iframe') return [frame];
      if (s === 'audio') return audioInIframe ? [] : audioEls;
      if (s === '[class*="face"],[id*="face"],[class*="Face"],[id*="Face"]') return [];
      return [];
    },
    addEventListener() {}, removeEventListener() {},
  };

  audioEls.forEach((a, i) => {
    a.ownerDocument = audioInIframe ? innerDoc : documentEl;
    const finishedBox = audioOpts[i].finishedBox;
    if (finishedBox === undefined) return;                 // 不放进任务点容器
    const icon = finishedBox
      ? makeEl('span', ['ans-job-icon', 'ans-job-audio'])                                  // 无 -clear = 已完成
      : makeEl('span', ['ans-job-icon', 'ans-job-audio', 'ans-job-icon-clear']);            // 带 -clear = 未完成
    const box = makeEl('div', ['ans-attach-ct']);
    box._map['.ans-job-icon'] = icon;
    a._closest = box;
  });

  const windowEl = {
    document: documentEl,
    location: {
      hostname: 'mooc1.chaoxing.com',
      pathname: '/mycourse/studentstudy',
      href: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=111&courseId=222',
      search: '?chapterId=111&courseId=222',
    },
    self: null, top: null, frames: [],
    history: { length: 2, back() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    addEventListener() {}, postMessage() {}, confirm: () => true, prompt: () => '',
    FontFace: class { constructor(f) { this.family = f; } load() { return Promise.resolve(this); } },
    setTimeout: (fn) => setTimeout(fn, 0), setInterval: () => 0, clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    Blob: class {}, URL: { createObjectURL: () => 'b', revokeObjectURL() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, key() { return null; }, length: 0 },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    console: { log() {}, warn() {}, error() {} },
  };
  windowEl.self = windowEl;
  windowEl.top = windowEl;   // IS_TOP = true（tickAudio / tickDoc / tickDiag 都只在顶层驱动）

  const gm = {};
  const sandbox = {
    window: windowEl, document: documentEl, unsafeWindow: windowEl, location: windowEl.location,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => setTimeout(fn, 0), setInterval: () => 0,
    clearTimeout: () => {}, clearInterval: () => {},
    MutationObserver: windowEl.MutationObserver, Blob: windowEl.Blob, URL: windowEl.URL,
    localStorage: windowEl.localStorage, sessionStorage: windowEl.sessionStorage,
    fetch: () => Promise.resolve({ text: () => Promise.resolve(''), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
    GM_getValue: (k, d) => (k === 'cfg' ? stored : (k in gm ? gm[k] : d)),
    GM_setValue: (k, v) => { gm[k] = v; },
    GM_xmlhttpRequest: (o2) => { if (o2.onerror) setTimeout(() => o2.onerror(), 0); },
    __gm: gm,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = windowEl;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'user.js', timeout: 15000 });
  return {
    debug: windowEl.__CXAS_DEBUG,
    sandbox: sandbox,
    gm: gm,
    audio: audioEls[0] || null,
    audios: audioEls,
    scroller: innerScroller,
    jobIcons: jobIcons,
  };
}

/* 让沙箱里的 Date.now() 走到指定时刻：用来验证 60 秒抖动窗口 / 5 秒诊断节流这类纯时间逻辑。 */
function setNow(ctx, t) {
  vm.runInContext('Date.now = function () { return ' + Number(t) + '; };', ctx.sandbox);
}

// ============ 0. 调试钩子 ============
console.log('[0] 调试钩子导出');
{
  const d = boot({}).debug;
  ok('调试钩子已挂载', !!d);
  ok('版本升到 4.x', !!d && /^4\./.test(String(d.version || '')), d && d.version);
  ok('导出了 noteFlapEvent', !!d && typeof d.noteFlapEvent === 'function');
  ok('导出了 flapState', !!d && typeof d.flapState === 'function');
  ok('导出了 tickAudio', !!d && typeof d.tickAudio === 'function');
  ok('导出了 tickDiag', !!d && typeof d.tickDiag === 'function');
}

// ============ 1. 抖动：未达阈值不熔断 ============
console.log('[1] noteFlapEvent 未达阈值不熔断');
{
  const ctx = boot({});
  const d = ctx.debug;
  ok('初始未熔断', d.flapState().tripped === false);
  ok('初始仍在运行', d.cfg.enabled === true);

  for (let i = 0; i < 11; i++) d.noteFlapEvent();   // 默认 flapMaxPerMin = 12
  ok('调用 11 次后计数为 11', d.flapState().count === 11, 'count=' + d.flapState().count);
  ok('调用 11 次未熔断（阈值是 >12 之前不动作）', d.flapState().tripped === false);
  ok('调用 11 次后 CFG.enabled 仍为 true', d.cfg.enabled === true);
}

// ============ 2. 抖动：达到阈值即熔断 ============
console.log('[2] noteFlapEvent 达到 flapMaxPerMin 熔断');
{
  const ctx = boot({});
  const d = ctx.debug;
  for (let i = 0; i < 11; i++) d.noteFlapEvent();
  d.noteFlapEvent();                                // 第 12 次
  ok('第 12 次后已熔断', d.flapState().tripped === true);
  ok('熔断后 CFG.enabled 被置为 false', d.cfg.enabled === false);
  ok('lastAction 写明「抖动」原因', /抖动/.test(String(d.stats.lastAction || '')), d.stats.lastAction);
  ok('stats.flap 写入熔断状态与次数', /熔断/.test(String(d.stats.flap || '')) && /12/.test(String(d.stats.flap || '')), d.stats.flap);
  ok('熔断状态持久化到配置存储', !!(ctx.gm.cfg && ctx.gm.cfg.enabled === false));

  const frozen = d.flapState().count;
  d.noteFlapEvent();
  d.noteFlapEvent();
  ok('熔断后不再继续计数（不自动恢复）', d.flapState().count === frozen && d.flapState().tripped === true, 'count=' + d.flapState().count);
}

// ============ 3. 抖动：60 秒窗口会过期 ============
console.log('[3] noteFlapEvent 60 秒窗口过期后重新计数');
{
  const base = 1760000000000;
  const ctx = boot({});
  const d = ctx.debug;
  setNow(ctx, base);
  for (let i = 0; i < 11; i++) d.noteFlapEvent();
  ok('窗口内 11 次不熔断', d.flapState().tripped === false && d.flapState().count === 11);

  setNow(ctx, base + 61000);   // 跨过 60 秒窗口
  d.noteFlapEvent();
  ok('窗口外的旧事件被丢弃（只剩 1 条）', d.flapState().count === 1, 'count=' + d.flapState().count);
  ok('过期后单次调用不熔断', d.flapState().tripped === false && d.cfg.enabled === true);

  for (let i = 0; i < 10; i++) d.noteFlapEvent();
  ok('新窗口内累计 11 次仍未熔断', d.flapState().tripped === false && d.flapState().count === 11);
  d.noteFlapEvent();
  ok('新窗口内第 12 次熔断', d.flapState().tripped === true && d.cfg.enabled === false);
}

// ============ 4. 抖动：阈值可配置（不是写死 12） ============
console.log('[4] flapMaxPerMin 可配置');
{
  const d = boot({ cfg: { flapMaxPerMin: 3 } }).debug;
  d.noteFlapEvent();
  d.noteFlapEvent();
  ok('阈值 3：2 次不熔断', d.flapState().tripped === false && d.cfg.enabled === true);
  d.noteFlapEvent();
  ok('阈值 3：第 3 次熔断', d.flapState().tripped === true && d.cfg.enabled === false);
}

// ============ 5. 音频：跨同源 iframe 找到并播放 ============
console.log('[5] tickAudio 跨 iframe 播放');
{
  const ctx = boot({
    cfg: { audioTask: false, docTask: false, controlGapMs: 4000 },
    audio: { currentTime: 12, duration: 300 },
  });
  const d = ctx.debug;
  const a = ctx.audio;
  ok('audioTask 关闭时一次都不播', a.plays === 0, 'plays=' + a.plays);

  d.cfg.audioTask = true;
  d.tickAudio();
  ok('开起来后会尝试播放（iframe 里的 <audio> 被找到）', a.plays === 1, 'plays=' + a.plays);
  ok('播放后 paused 变 false', a.paused === false);
  ok('stats.audio 显示播放中与进度', /播放中/.test(String(d.stats.audio || '')) && /12\/300s/.test(String(d.stats.audio || '')), d.stats.audio);

  d.tickAudio();
  ok('已在播放时不再重复 play()（不抢控制权）', a.plays === 1, 'plays=' + a.plays);
}

// ============ 6. 音频：controlGapMs 限频 ============
console.log('[6] tickAudio 按 controlGapMs 限频');
{
  const ctx = boot({
    cfg: { audioTask: false, docTask: false, controlGapMs: 3000 },
    audio: { autoplayBlocked: true, duration: 300 },   // 自动播放被拦：paused 不变 → 只有限频能挡住下一次
  });
  const d = ctx.debug;
  const a = ctx.audio;
  d.cfg.audioTask = true;

  d.tickAudio();
  ok('第一次尝试播放', a.plays === 1, 'plays=' + a.plays);
  ok('自动播放被拦时状态是未播放', a.paused === true && /未播放/.test(String(d.stats.audio || '')), d.stats.audio);

  d.tickAudio();
  ok('紧接着第二次调用被限频挡住', a.plays === 1, 'plays=' + a.plays);

  d.cfg.controlGapMs = 0;   // 0 是合法值（=不节流），不是"回退到 4000"
  d.tickAudio();
  ok('controlGapMs=0 时立即重试', a.plays === 2, 'plays=' + a.plays);
  d.tickAudio();
  ok('controlGapMs=0 下每次 tick 都可重试', a.plays === 3, 'plays=' + a.plays);
}

// ============ 7. 音频：播完（ended）不再播 ============
console.log('[7] tickAudio 已播完不再 play');
{
  const ctx = boot({
    cfg: { audioTask: false, docTask: false, controlGapMs: 0 },
    audio: { ended: true, currentTime: 300, duration: 300 },
  });
  const d = ctx.debug;
  d.cfg.audioTask = true;
  d.tickAudio();
  ok('ended=true 不会被拉起（避免无限重播）', ctx.audio.plays === 0, 'plays=' + ctx.audio.plays);
  ok('stats.audio 报未播放', /未播放/.test(String(d.stats.audio || '')), d.stats.audio);
}

// ============ 8. 音频：不可见的不碰 ============
console.log('[8] tickAudio 只处理可见音频');
{
  const ctx = boot({
    cfg: { audioTask: false, docTask: false, controlGapMs: 0 },
    audio: { width: 0, height: 0, duration: 300 },
  });
  const d = ctx.debug;
  d.cfg.audioTask = true;
  d.tickAudio();
  ok('尺寸为 0 的音频不播', ctx.audio.plays === 0, 'plays=' + ctx.audio.plays);
  ok('没有可播音频时 stats.audio 是空字符串（不是 undefined）', d.stats.audio === '', JSON.stringify(d.stats.audio));
}

// ============ 9. 任务点诊断字段可读 ============
console.log('[9] 任务点诊断字段（tickDoc / tickAudio）');
{
  const ctx = boot({ cfg: { docScrollIntervalMs: 0 }, docTask: true, questionCount: 0 });
  const d = ctx.debug;
  ok('stats.doc 是字符串', typeof d.stats.doc === 'string', JSON.stringify(d.stats.doc));
  ok('主循环已经把文档任务点推进写进 stats.doc', /文档任务点/.test(String(d.stats.doc || '')), d.stats.doc);
  ok('滚动位置确实前进了', ctx.scroller.scrollTop > 0, 'scrollTop=' + ctx.scroller.scrollTop);

  const before = ctx.scroller.scrollTop;
  d.tickDoc();
  ok('再驱动一次 tickDoc 继续前进', ctx.scroller.scrollTop > before, before + ' -> ' + ctx.scroller.scrollTop);

  ok('stats.audio 字段存在且是字符串', typeof d.stats.audio === 'string', JSON.stringify(d.stats.audio));
  ok('stats.flap 字段存在且是字符串', typeof d.stats.flap === 'string', JSON.stringify(d.stats.flap));
  ok('stats.diag 字段存在（值可为空串）', 'diag' in d.stats && typeof d.stats.diag === 'string', JSON.stringify(d.stats.diag));
}

// ============ 10. tickDiag 统计任务点类型与题目数 ============
console.log('[10] tickDiag 识别任务点类型与题目数');
{
  const ctx = boot({
    cfg: { docTask: false, audioTask: false },
    cardsDoc: true,
    jobIcons: [
      'ans-job-icon ans-job-video ans-job-icon-clear',
      'ans-job-icon ans-job-video ans-job-icon-clear',
      'ans-job-icon ans-job-doc ans-job-icon-clear',
    ],
    questionCount: 3,
  });
  const d = ctx.debug;
  const diag = String(d.stats.diag || '');
  ok('主循环已写入 stats.diag', diag.length > 0, diag);
  ok('统计到视频任务点 ×2', /video×2/.test(diag), diag);
  ok('统计到文档任务点 ×1', /doc×1/.test(diag), diag);
  ok('统计到题目数 3', /题\s*3/.test(diag), diag);

  // 5 秒节流：立即再调不会重扫（DOM 里多一个图标也不更新）
  ctx.jobIcons.push(makeEl('span', ['ans-job-icon', 'ans-job-audio', 'ans-job-icon-clear']));
  d.tickDiag();
  ok('5 秒内不重复扫描', /video×2/.test(String(d.stats.diag || '')) && !/audio×1/.test(String(d.stats.diag || '')), d.stats.diag);

  setNow(ctx, Date.now() + 6000);
  d.tickDiag();
  ok('节流到期后重新扫描到新增任务点', /audio×1/.test(String(d.stats.diag || '')), d.stats.diag);
}

// ============ 11. 总开关门禁（回归：暂停/熔断后不得继续驱动任务点）============
console.log('[11] CFG.enabled=false 后 tickDoc / tickAudio 都不再驱动');
{
  const ctx = boot({
    cfg: { audioTask: false, docScrollIntervalMs: 0, controlGapMs: 0 },
    docTask: true,
    audio: { autoplayBlocked: true, duration: 300 },   // 被拦：paused 一直 true，只有门禁能挡住下一次 play
  });
  const d = ctx.debug;
  const a = ctx.audio;

  d.cfg.audioTask = true;
  d.tickAudio();
  ok('正常运行时会驱动音频', a.plays === 1, 'plays=' + a.plays);
  d.tickDoc();
  const scrolled = ctx.scroller.scrollTop;
  ok('正常运行时会驱动文档滚动', scrolled > 0, 'scrollTop=' + scrolled);

  d.cfg.enabled = false;   // 面板「暂停」与抖动熔断都走这条路径
  d.tickDoc();
  ok('CFG.enabled=false 后 tickDoc 不再滚动（原 bug）', ctx.scroller.scrollTop === scrolled, 'scrollTop=' + ctx.scroller.scrollTop);
  d.tickAudio();
  ok('CFG.enabled=false 后 tickAudio 不再 play（原 bug）', a.plays === 1, 'plays=' + a.plays);

  d.cfg.enabled = true;
  d.tickDoc();
  ok('恢复 enabled 后 tickDoc 继续推进（不是永久锁死）', ctx.scroller.scrollTop > scrolled, scrolled + ' -> ' + ctx.scroller.scrollTop);
  d.tickAudio();
  ok('恢复 enabled 后 tickAudio 继续驱动', a.plays === 2, 'plays=' + a.plays);
}

// ============ 12. 音频的 play/pause 计入抖动熔断（回归：原先是盲区）============
console.log('[12] 音频事件接入抖动熔断');
{
  const ctx = boot({
    cfg: { audioTask: false, docTask: false, controlGapMs: 4000 },
    audio: { autoplayBlocked: true, duration: 300 },
  });
  const d = ctx.debug;
  const a = ctx.audio;
  d.cfg.audioTask = true;
  d.tickAudio();

  ok('tickAudio 给音频注册了 play 监听', (a._listeners.play || []).length === 1, 'play 监听 ' + (a._listeners.play || []).length);
  ok('tickAudio 给音频注册了 pause 监听', (a._listeners.pause || []).length === 1, 'pause 监听 ' + (a._listeners.pause || []).length);
  ok('打了 __cxasFlapBound 标记', a.__cxasFlapBound === true);

  d.tickAudio();
  ok('再次 tick 不会重复挂监听（重复挂会让熔断提前误触发）',
    (a._listeners.play || []).length === 1 && (a._listeners.pause || []).length === 1,
    'play=' + (a._listeners.play || []).length + ' pause=' + (a._listeners.pause || []).length);

  ok('派发事件前计数为 0', d.flapState().count === 0, 'count=' + d.flapState().count);
  fire(a, 'play');
  ok('音频 play 事件真的进入计数器', d.flapState().count === 1, 'count=' + d.flapState().count);
  fire(a, 'pause');
  ok('音频 pause 事件也计入', d.flapState().count === 2, 'count=' + d.flapState().count);

  fire(a, 'play', 9);   // 2 + 9 = 11
  ok('累计 11 次仍未熔断', d.flapState().count === 11 && d.flapState().tripped === false, 'count=' + d.flapState().count);
  fire(a, 'play');      // 第 12 次
  ok('音频抖动累计到 12 次即熔断', d.flapState().tripped === true && d.cfg.enabled === false);
  ok('熔断原因写明「抖动」', /抖动/.test(String(d.stats.lastAction || '')), d.stats.lastAction);
  fire(a, 'pause');
  ok('熔断后音频事件不再计数', d.flapState().count === 12, 'count=' + d.flapState().count);

  const afterTrip = a.plays;
  d.cfg.controlGapMs = 0;   // 关掉限频：没有总开关门禁的话这里一定会再 play 一次
  d.tickAudio();
  ok('熔断后即使关掉限频也不再驱动音频（门禁与熔断联动）', a.plays === afterTrip, 'plays=' + a.plays);
}

// ============ 13. 多个音频：完成态过滤 + 一 tick 只驱动一个（回归：原先只取 audios[0]）============
console.log('[13] 多个音频时的选择与完成态过滤');
{
  /* (a) 第一个落在"已完成"任务点（图标没有 -clear），第二个未完成 */
  const ctx = boot({
    cfg: { audioTask: false, docTask: false, controlGapMs: 0 },
    audios: [
      { finishedBox: true, duration: 300 },    // 已完成 → 不该被拉起
      { finishedBox: false, duration: 300 },   // 未完成 → 该被驱动
    ],
  });
  const d = ctx.debug;
  d.cfg.audioTask = true;
  d.tickAudio();
  ok('已完成任务点里的音频不被驱动', ctx.audios[0].plays === 0, 'plays=' + ctx.audios[0].plays);
  ok('未完成任务点里的音频被驱动', ctx.audios[1].plays === 1, 'plays=' + ctx.audios[1].plays);
  ok('统计里只算未完成的那一个（不出现「共 N 个」）', !/共/.test(String(d.stats.audio || '')), d.stats.audio);

  /* (b) 两个都未完成：一 tick 只驱动一个，并标注总数 */
  const ctx2 = boot({
    cfg: { audioTask: false, docTask: false, controlGapMs: 0 },
    audios: [{ finishedBox: false, duration: 300 }, { finishedBox: false, duration: 300 }],
  });
  const d2 = ctx2.debug;
  d2.cfg.audioTask = true;
  d2.tickAudio();
  const totalFirst = ctx2.audios[0].plays + ctx2.audios[1].plays;
  ok('两个都未完成时一 tick 只驱动一个', totalFirst === 1, 'plays=' + totalFirst);
  ok('stats.audio 标注一共有 2 个', /（共 2 个）/.test(String(d2.stats.audio || '')), d2.stats.audio);

  d2.tickAudio();
  ok('下一个 tick 轮到另一个（不会永远卡在第一个）',
    ctx2.audios[1].plays === 1 && (ctx2.audios[0].plays + ctx2.audios[1].plays) === 2,
    'a0=' + ctx2.audios[0].plays + ' a1=' + ctx2.audios[1].plays);
}

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
