// 长页面/懒加载处理 + 漏题诊断
// 运行：node tests/scroll.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'xuexitong-assistant.user.js'), 'utf8');

function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(), nodeType: 1,
    style: { cssText: '', setProperty() {}, getPropertyValue() { return ''; } },
    children: [], parentElement: null, id: '', textContent: '', value: '', checked: false, files: [],
    appendChild(c) { this.children.push(c); return c; },
    remove() {}, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    click() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, cloneNode() { return makeEl(this.tagName); },
    getBoundingClientRect() { return { width: 100, height: 50, top: 0, left: 0 }; },
    scrollIntoView() {},
    getContext() {
      return {
        font: '20px sans-serif', textBaseline: 'top', textAlign: 'left', fillStyle: '#000',
        clearRect() {}, fillText() {}, measureText() { return { width: 10 }; },
        getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
      };
    },
  };
}

/* lazyBatches: 每次"滚到底"新增渲染多少题（模拟分片加载）
 * 例如 [3, 2, 0] = 滚一次 +3 题、再滚 +2、再滚不再增加 */
function boot(bodyText, lazyBatches) {
  const batches = (lazyBatches || []).slice();
  let rendered = 0;
  let scrollCalls = 0;
  let scrollPos = 0;

  const bodyEl = makeEl('body');
  bodyEl.textContent = bodyText || '';
  bodyEl.scrollHeight = 2000;

  const documentEl = {
    nodeType: 9, body: bodyEl, head: makeEl('head'), documentElement: makeEl('html'), title: '',
    fonts: { add() {}, ready: Promise.resolve() },
    styleSheets: [],
    createElement: (t) => makeEl(t),
    getElementById() { return null; },
    // 模拟"当前 DOM 里有多少题目块"
    querySelectorAll(sel) {
      if (sel && /TiMu|questionLi/.test(sel)) {
        const arr = [];
        for (let i = 0; i < rendered; i++) arr.push(makeEl('div'));
        return arr;
      }
      return [];
    },
    querySelector() { return null; },
    addEventListener() {}, removeEventListener() {},
  };

  const windowEl = {
    document: documentEl,
    location: { hostname: 'mooc1.chaoxing.com', pathname: '/work/x', href: 'https://x/', search: '' },
    self: null, top: null, frames: [],
    history: { length: 2, back() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    addEventListener() {}, postMessage() {}, confirm: () => true, prompt: () => '',
    FontFace: class { constructor(f) { this.family = f; } load() { return Promise.resolve(this); } },
    setTimeout: (fn) => setTimeout(fn, 0), setInterval: () => 0, clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    Blob: class {}, URL: { createObjectURL: () => 'b', revokeObjectURL() {} },
    scrollTo(x, y) {
      scrollCalls++;
      scrollPos = y;
      // 滚到底就渲染下一批（模拟懒加载）
      if (y > 0 && batches.length) {
        const next = batches.shift();
        if (typeof next === 'number') rendered += next;
      }
    },
    localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }, key(i) { return Object.keys(this._d)[i] ?? null; }, get length() { return Object.keys(this._d).length; } },
    sessionStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
    console: { log() {}, warn() {}, error() {} },
  };
  windowEl.self = windowEl;
  windowEl.top = windowEl;
  documentEl.defaultView = windowEl;

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
  return { dbg: windowEl.__CXAS_DEBUG, stats: () => ({ scrollCalls, scrollPos, rendered }) };
}

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n    实得 ' + g + '\n    期望 ' + w); }
}
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}

// ============ 1. 漏题诊断：读页面声明的总题数 ============
console.log('[1] 读取页面声明的题目总数');
[
  ['本测验共 20 题，请注意时间', 20],
  ['全部 12 道题', 12],
  ['总计 8 个题', 8],
  ['共 5 题', 5],
  ['没有说明题数', null],
  ['共 0 题', null],        // 0 不合理，应拒绝
  ['共 999 题', null],      // 超上限（>500），应拒绝
].forEach(([text, want]) => {
  const { dbg } = boot(text);
  eq('"' + text + '" → ' + want, dbg.expectedQuestionCount(), want);
});

// ============ 2. 滚动触发懒加载 ============
console.log('\n[2] scrollToLoadAll 触发分片渲染');
(async () => {
  {
    // 首次 3 题，滚一次到 5，再滚不再增长
    const { dbg, stats } = boot('', [3, 2, 0]);
    const before = dbg.expectedQuestionCount !== undefined;
    const n = await dbg.scrollToLoadAll(null, 6);
    const s = stats();
    ok('滚动被调用', s.scrollCalls > 0, '调用 ' + s.scrollCalls + ' 次');
    eq('最终题目块数', n, 5);
    ok('结束后回到顶部', s.scrollPos === 0, 'pos=' + s.scrollPos);
  }
  {
    // 一开始就全部渲染：滚一次发现不增长就停（不该滚 6 次）
    const { dbg, stats } = boot('', [10]);
    const n = await dbg.scrollToLoadAll(null, 6);
    eq('无懒加载时块数不变', n, 10);
    ok('提前退出（滚动次数少）', stats().scrollCalls <= 4, '调用 ' + stats().scrollCalls + ' 次');
  }
  {
    // 持续增长的极端情况：必须被 maxRounds 截断
    const { dbg, stats } = boot('', [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const n = await dbg.scrollToLoadAll(null, 4);
    ok('受 maxRounds 限制，不会无限滚', stats().scrollCalls <= 5, '调用 ' + stats().scrollCalls + ' 次, 块数 ' + n);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
