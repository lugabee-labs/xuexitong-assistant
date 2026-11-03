// B1 单测（t11）：ended 后播放器自动从头重播时，"已播完"不能被抹掉、跳转不能被延迟。
// 运行：node tests/video-completion.test.js
//
// 为什么必须单测：
//   B1 有两层根因：① playing 事件把 endedFlag 清掉；② 完播判定是 endedFlag && posAtEnd，
//   自动重播后 cur≈0 → posAtEnd 为假，即使标记锁住也不跳。真浏览器里这两个时序很难稳定复现，
//   用"可派发事件的 mock video"最可靠。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'xuexitong-assistant.user.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}

function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(), nodeType: 1,
    style: { cssText: '', display: '' },
    children: [], parentElement: null, id: '', className: '', textContent: '',
    value: '', checked: false, files: [],
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    remove() {}, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    click() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, cloneNode() { return makeEl(this.tagName); },
    getBoundingClientRect() { return { width: 100, height: 50, top: 0, left: 0 }; },
    getContext() {
      return {
        font: '20px sans-serif', textBaseline: 'top', textAlign: 'left', fillStyle: '#000',
        clearRect() {}, fillText() {}, measureText() { return { width: 10 }; },
        getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
      };
    },
  };
}

function makeVideo(documentEl) {
  const listeners = {};
  const v = {
    tagName: 'VIDEO', nodeType: 1, isConnected: true,
    paused: false, ended: false, duration: 100, currentTime: 99.5,
    playbackRate: 1, muted: false, volume: 1,
    src: 'http://mock.local/lesson.webm', currentSrc: 'http://mock.local/lesson.webm',
    ownerDocument: documentEl,
    pauseCalls: 0, playCalls: 0,
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener() {},
    emit(ev) { (listeners[ev] || []).forEach((fn) => { try { fn({ type: ev }); } catch (e) { /* 忽略 */ } }); },
    play() { this.paused = false; this.playCalls += 1; return Promise.resolve(); },
    pause() { this.paused = true; this.pauseCalls += 1; },
    getBoundingClientRect() { return { width: 640, height: 360, top: 0, left: 0 }; },
    closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
  return v;
}

function boot(cfgOverrides) {
  const created = [];
  const bodyEl = makeEl('body');
  created.push(bodyEl);
  const videoEl = makeVideo(null);
  const nexts = [];

  const documentEl = {
    nodeType: 9, body: bodyEl, head: makeEl('head'), documentElement: makeEl('html'),
    title: '', fonts: { add() {}, delete() {}, ready: Promise.resolve() }, styleSheets: [],
    createElement: (t) => { const el = makeEl(t); created.push(el); return el; },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll(sel) { return (String(sel) === 'video') ? [videoEl] : []; },
    addEventListener() {}, removeEventListener() {},
  };
  videoEl.ownerDocument = documentEl;

  const windowEl = {
    document: documentEl,
    location: {
      hostname: 'mooc1.chaoxing.com', host: 'mooc1.chaoxing.com',
      pathname: '/mycourse/studentstudy', href: 'https://mooc1.chaoxing.com/x', search: '',
    },
    self: null, top: null, frames: [],
    history: { length: 1, back() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    addEventListener() {}, removeEventListener() {},
    postMessage(msg) { if (msg && msg.__cxas === 'NEXT') nexts.push(msg); },
    confirm: () => true, prompt: () => '',
    FontFace: class { constructor(f, s) { this.family = f; this.source = s; } load() { return Promise.resolve(this); } },
    setTimeout: (fn, ms) => setTimeout(fn, 0),
    setInterval: () => 0, clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    Blob: class {}, URL: { createObjectURL: () => 'b', revokeObjectURL() {} },
    localStorage: {
      _d: {}, getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
      setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
      key(i) { return Object.keys(this._d)[i] || null; },
      get length() { return Object.keys(this._d).length; },
    },
    sessionStorage: {
      _d: {}, getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
      setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
    },
    console: { log() {}, warn() {}, error() {} },
  };
  windowEl.self = windowEl;
  windowEl.top = windowEl;

  const cfg = Object.assign({
    verbose: true,
    activeHours: '',            // 排除作息时段对完播判定的干扰
    humanizePauseChance: 0,     // 排除随机暂停
    completeDelay: 50,
    thresholdDelay: 50,
    minWatchSeconds: 30,
  }, cfgOverrides || {});

  const sandbox = {
    window: windowEl, document: documentEl, unsafeWindow: windowEl, location: windowEl.location,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => setTimeout(fn, 0), setInterval: () => 0,
    clearTimeout: () => {}, clearInterval: () => {},
    MutationObserver: windowEl.MutationObserver, Blob: windowEl.Blob, URL: windowEl.URL,
    localStorage: windowEl.localStorage, sessionStorage: windowEl.sessionStorage,
    fetch: () => Promise.resolve({ text: () => Promise.resolve(''), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
    GM_getValue: (k, d) => (k === 'cfg' ? cfg : (k in sandbox.__gm ? sandbox.__gm[k] : d)),
    GM_setValue: (k, v) => { sandbox.__gm[k] = v; },
    GM_xmlhttpRequest: (o) => { if (o && o.onerror) setTimeout(() => o.onerror(), 0); },
    __gm: {},
  };
  sandbox.globalThis = sandbox;
  sandbox.self = windowEl;

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'user.js', timeout: 15000 });
  const dbg = windowEl.__CXAS_DEBUG;
  if (!dbg) throw new Error('未取到调试钩子');
  return { dbg, videoEl, nexts, tick: () => dbg.tickVideo() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('[1] ended 后自动重播（playing, currentTime≈0）：跳转不能被延迟');
  const a = boot();
  a.tick();                              // 先完成绑定/身份键
  a.videoEl.currentTime = 100;
  a.videoEl.emit('ended');               // 真播完
  a.tick();
  ok('ended 后标记已锁定', a.dbg.endedState().flag === true, JSON.stringify(a.dbg.endedState()));
  // 模拟真实播放器：ended 后自动从头重播，派发 playing 且 currentTime≈0
  a.videoEl.ended = false;
  a.videoEl.currentTime = 0.2;
  a.videoEl.emit('playing');
  a.tick();
  ok('自动重播不会清掉 endedFlag', a.dbg.endedState().flag === true);
  await sleep(30);                        // 给 completeDelay 的 setTimeout 机会
  ok('自动重播后仍然触发了下一节（NEXT）', a.nexts.length === 1, 'nexts=' + a.nexts.length);
  ok('lastAction 说明是"已播完"跳转', /已播完/.test(a.dbg.stats.lastAction), a.dbg.stats.lastAction);

  console.log('\n[2] 真正的换源（loadstart）：必须清掉 ended 锁定并恢复自动播放');
  const b = boot({ autoNext: false });   // 只验证"重置"，不要被跳转干扰
  b.tick();
  b.videoEl.currentTime = 100;
  b.videoEl.emit('ended');
  b.tick();
  b.videoEl.ended = false;
  b.videoEl.currentTime = 0;
  b.videoEl.paused = true;              // 换源后播放器处于暂停态
  b.videoEl.emit('loadstart');
  b.tick();
  await sleep(30);
  ok('loadstart 后 endedFlag 已清', b.dbg.endedState().flag === false);
  ok('loadstart 后 autoPlay 恢复播放', b.videoEl.playCalls >= 1, 'playCalls=' + b.videoEl.playCalls);
  ok('loadstart 后没有误发 NEXT', b.nexts.length === 0, 'nexts=' + b.nexts.length);

  console.log('\n[3] 没触发 loadstart 的换源（src 变了）：靠身份键兜底清标记');
  const c = boot({ autoNext: false });   // 同上：只验证身份键兜底清标记
  c.tick();
  c.videoEl.currentTime = 100;
  c.videoEl.emit('ended');
  c.tick();
  ok('先锁定', c.dbg.endedState().flag === true);
  // 只改 currentSrc（不派发 playing/loadstart）：模拟"同元素直接换源但事件没到"的情况
  c.videoEl.currentSrc = 'http://mock.local/lesson2.webm';
  c.videoEl.src = 'http://mock.local/lesson2.webm';
  c.videoEl.currentTime = 1;
  c.videoEl.ended = false;
  c.tick();
  await sleep(30);
  ok('身份键变化后 endedFlag 被清', c.dbg.endedState().flag === false);
  ok('身份键变化后没有误发 NEXT', c.nexts.length === 0, 'nexts=' + c.nexts.length);

  console.log('\n[4] 同一段视频（src/duration 不变）不因 playing 复位而丢状态');
  const d = boot();
  d.tick();
  d.videoEl.currentTime = 100;
  d.videoEl.emit('ended');
  d.tick();
  const keyBefore = d.dbg.endedState().key;
  d.videoEl.ended = false;
  d.videoEl.currentTime = 0;
  d.videoEl.emit('playing');
  d.tick();
  ok('同一视频身份键保持不变', d.dbg.endedState().key === keyBefore && !!keyBefore,
    keyBefore + ' → ' + d.dbg.endedState().key);

  console.log('\n[5] t28/F1：超时后重播 maxRetry 次即**必硬跳**（旧实现硬跳出口不可达）');
  {
    const W = boot({
      waitForCompletion: true, completionTimeoutMs: 120, completionPollMs: 50,
      completionMaxRetry: 1, completeDelay: 0, autoNext: false,
    });
    const first = await W.dbg.waitForCompletionMark();
    ok('第一次超时 → 重播（返回 false）', first === false, 'ret=' + first);
    ok('重播计数累计为 1', W.dbg.completionRetriesUsed() === 1, 'retries=' + W.dbg.completionRetriesUsed());
    ok('状态文案说明正在重播', /重播中（第 1 次）/.test(W.dbg.stats.completionState), W.dbg.stats.completionState);
    const second = await W.dbg.waitForCompletionMark();
    ok('第二次超时 → 硬跳（返回 true）', second === true, 'ret=' + second);
    ok('lastAction 写明「硬跳转」', /硬跳转/.test(W.dbg.stats.lastAction), W.dbg.stats.lastAction);
    ok('状态文案为「仍无标记」', /仍无标记/.test(W.dbg.stats.completionState), W.dbg.stats.completionState);
    const third = await W.dbg.waitForCompletionMark();
    ok('同一节再判也是硬跳（绝不再回到重播）', third === true && W.dbg.completionRetriesUsed() === 1,
      'ret=' + third + ' retries=' + W.dbg.completionRetriesUsed());
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('FAIL 异常：' + (e && e.stack || e));
  process.exit(1);
});