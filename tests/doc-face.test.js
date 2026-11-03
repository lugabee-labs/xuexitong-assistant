// v3.1 新功能单测：非视频任务点（文档/PPT/音频）推进 + 人脸核验探测
// 运行：node tests/doc-face.test.js
//
// 为什么单测：tickDoc 与 faceGuardActive 都在真实页面里"不报错但也不生效"最难发现——
// 前者少了 -clear 判据就会空转，后者误判会把正常页面锁死成"等人脸"。

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
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
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

/* 构造一个"文档任务点"页面：
 *   top doc 里有 .ans-attach-ct > (.ans-job-icon[.ans-job-icon-clear] + iframe)
 *   iframe 里的文档是可滚动正文（scrollHeight 远大于 clientHeight）
 */
function boot(opts) {
  const o = opts || {};
  const bodyEl = makeEl('body');
  const innerScroller = makeEl('div');
  innerScroller.scrollTop = 0;
  innerScroller.scrollHeight = 3000;
  innerScroller.clientHeight = 600;

  const innerDoc = {
    nodeType: 9, body: makeEl('body'), documentElement: makeEl('html'), title: '',
    scrollingElement: innerScroller,
    querySelector() { return null; }, querySelectorAll() { return []; },
    createElement: (t) => makeEl(t), getElementById() { return null; },
    addEventListener() {}, styleSheets: [], fonts: { add() {}, ready: Promise.resolve() },
  };

  const frame = makeEl('iframe');
  frame.contentDocument = innerDoc;

  const icon = makeEl('span', o.iconClasses || ['ans-job-icon', 'ans-job-doc', 'ans-job-icon-clear']);
  const box = makeEl('div', ['ans-attach-ct']);
  box._map['.ans-job-icon'] = icon;
  box._map['iframe'] = frame;
  if (o.videoTask) box._map['.ans-job-video'] = makeEl('span', ['ans-job-video']);
  box.scrollHeight = 0; box.clientHeight = 0;

  const faceMask = makeEl('div', ['faceMaskDiv']);
  faceMask.textContent = o.faceText || '';

  const pushMask = !!o.face;
  const pushQr = !!o.qr;      // #fcqrimg 遮罩：只有明确要求时才注入，避免"任何 face 都算命中"的假阳性

  const documentEl = {
    nodeType: 9, body: bodyEl, head: makeEl('head'), documentElement: makeEl('html'), title: '',
    fonts: { add() {}, ready: Promise.resolve() }, styleSheets: [],
    createElement: (t) => makeEl(t),
    getElementById() { return null; },
    querySelector(s) {
      if (s === '#fcqrimg') return (pushMask && pushQr) ? faceMask : null;
      return null;
    },
    querySelectorAll(s) {
      if (s === '.ans-attach-ct') return [box];
      if (s === 'iframe') return [frame];
      if (s === '[class*="face"],[id*="face"],[class*="Face"],[id*="Face"]') return pushMask ? [faceMask] : [];
      return [];
    },
    addEventListener() {}, removeEventListener() {},
  };

  const windowEl = {
    document: documentEl,
    location: { hostname: 'mooc1.chaoxing.com', pathname: '/mycourse/studentstudy', href: 'https://mooc1.chaoxing.com/x', search: '' },
    self: null, top: null, frames: [],
    history: { length: 2, back() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    addEventListener() {}, postMessage() {}, confirm: () => true, prompt: () => '',
    FontFace: class { constructor(f) { this.family = f; } load() { return Promise.resolve(this); } },
    setTimeout: (fn) => setTimeout(fn, 0), setInterval: () => 0, clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    Blob: class {}, URL: { createObjectURL: () => 'b', revokeObjectURL() {} },
    localStorage: { _d: {}, getItem() { return null; }, setItem() {}, removeItem() {}, key() { return null; }, length: 0 },
    sessionStorage: { _d: {}, getItem() { return null; }, setItem() {}, removeItem() {} },
    console: { log() {}, warn() {}, error() {} },
  };
  windowEl.self = windowEl; windowEl.top = windowEl;

  const sandbox = {
    window: windowEl, document: documentEl, unsafeWindow: windowEl, location: windowEl.location,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => setTimeout(fn, 0), setInterval: () => 0,
    clearTimeout: () => {}, clearInterval: () => {},
    MutationObserver: windowEl.MutationObserver, Blob: windowEl.Blob, URL: windowEl.URL,
    localStorage: windowEl.localStorage, sessionStorage: windowEl.sessionStorage,
    fetch: () => Promise.resolve({ text: () => Promise.resolve(''), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
    GM_getValue: (k, d) => (k === 'cfg' ? { verbose: true } : (k in sandbox.__gm ? sandbox.__gm[k] : d)),
    GM_setValue: (k, v) => { sandbox.__gm[k] = v; },
    GM_xmlhttpRequest: (o) => { if (o.onerror) setTimeout(() => o.onerror(), 0); },
    __gm: {},
  };
  sandbox.globalThis = sandbox;
  sandbox.self = windowEl;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'user.js', timeout: 15000 });
  return { debug: windowEl.__CXAS_DEBUG, icon, box, frame, innerScroller, innerDoc, documentEl };
}

// ============ 1. 未完成的文档任务点会被推进 ============
console.log('[1] 文档/PPT 任务点自动滚动');
{
  const ctx = boot({});
  const d = ctx.debug;
  ok('调试钩子导出了 tickDoc', typeof d.tickDoc === 'function');
  d.cfg.docTask = true;
  d.cfg.docScrollIntervalMs = 0;          // 关掉节流，方便断言
  const before = ctx.innerScroller.scrollTop;
  d.tickDoc();
  const after = ctx.innerScroller.scrollTop;
  ok('滚动位置前进', after > before, before + ' -> ' + after);
  ok('面板状态写明滚动进度', /文档任务点：滚动/.test(d.stats.doc || ''), d.stats.doc);
}

// ============ 2. 已完成的任务点不动 ============
console.log('[2] 已完成任务点不重复推进');
{
  const ctx = boot({ iconClasses: ['ans-job-icon', 'ans-job-doc'] });  // 没有 -clear = 已完成
  const d = ctx.debug;
  d.cfg.docScrollIntervalMs = 0;
  const before = ctx.innerScroller.scrollTop;
  d.tickDoc();
  ok('已完成则不滚动', ctx.innerScroller.scrollTop === before, String(ctx.innerScroller.scrollTop));
}

// ============ 3. 视频任务点交给 tickVideo，不被当成文档 ============
console.log('[3] 视频任务点不归文档逻辑管');
{
  const ctx = boot({ videoTask: true });
  const d = ctx.debug;
  d.cfg.docScrollIntervalMs = 0;
  const before = ctx.innerScroller.scrollTop;
  d.tickDoc();
  ok('视频任务点被跳过', ctx.innerScroller.scrollTop === before, String(ctx.innerScroller.scrollTop));
}

// ============ 4. 人脸核验探测 ============
console.log('[4] 人脸核验探测（只检测，不绕过）');
{
  const none = boot({ face: false }).debug;
  ok('无遮罩时判定为未触发', none.faceGuardActive() === false);

  const hit = boot({ face: true, qr: true, faceText: '请进行人脸识别后继续学习' }).debug;
  ok('命中 #fcqrimg 时判定为已触发', hit.faceGuardActive() === true);

  const txt = boot({ face: true, qr: false, faceText: '人脸核验' }).debug;
  ok('仅靠文案也能命中', txt.faceGuardActive() === true);

  const noise = boot({ face: true, qr: false, faceText: '踏青时节，注意防晒' }).debug;
  ok('无关文案不误判', noise.faceGuardActive() === false);
}

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
