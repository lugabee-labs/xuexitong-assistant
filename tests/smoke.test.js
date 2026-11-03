// 冒烟测试：用最小 DOM/油猴 API mock 执行脚本，捕获初始化阶段的运行时错误。
// 不验证业务正确性（那需要真实页面），只验证"能不能跑起来不炸"。
// 运行：node tests/smoke.test.js

const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(__dirname + '/../xuexitong-assistant.user.js', 'utf8');

let failed = null;
let appendedNodes = [];
let intervals = [];

function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    nodeType: 1,
    style: { cssText: '', setProperty() {}, getPropertyValue() { return ''; } },
    dataset: {},
    children: [],
    parentElement: null,
    id: '',
    textContent: '',
    value: '',
    checked: false,
    files: [],
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    remove() {},
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    click() {},
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    cloneNode() { return makeEl(this.tagName); },
    getBoundingClientRect() { return { width: 100, height: 50, top: 0, left: 0, right: 100, bottom: 50 }; },
    getContext() {
      return {
        font: '20px sans-serif',
        textBaseline: 'top',
        textAlign: 'left',
        fillStyle: '#000',
        clearRect() {}, fillText() {},
        measureText() { return { width: 10 }; },
        getImageData(x, y, w, h) {
          // 返回可预测的灰度图案，让字形特征不为空
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < w * h; i++) {
            const v = (i * 37) % 256;
            data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v;
            data[i * 4 + 3] = v > 128 ? 255 : 0;
          }
          return { data };
        },
      };
    },
  };
  return el;
}

const bodyEl = makeEl('body');
const headEl = makeEl('head');
const documentEl = {
  nodeType: 9,
  body: bodyEl,
  head: headEl,
  documentElement: makeEl('html'),
  fonts: { add() {}, ready: Promise.resolve() },
  styleSheets: [],
  createElement: (t) => makeEl(t),
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
  removeEventListener() {},
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
};

const windowEl = {
  document: documentEl,
  location: { hostname: 'mooc1.chaoxing.com', pathname: '/mycourse/studentstudy', href: 'https://mooc1.chaoxing.com/x', search: '' },
  self: null,
  top: null,
  frames: [],
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  addEventListener() {},
  removeEventListener() {},
  postMessage() {},
  confirm: () => true,
  prompt: () => '',
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
  window: windowEl,
  document: documentEl,
  unsafeWindow: windowEl,
  location: windowEl.location,
  console: { log() {}, warn() {}, error() {} },
  setTimeout: (fn, ms) => setTimeout(fn, 0),
  setInterval: (fn, ms) => { intervals.push(fn); return intervals.length; },
  clearTimeout: () => {},
  clearInterval: () => {},
  MutationObserver: windowEl.MutationObserver,
  Blob: windowEl.Blob,
  URL: windowEl.URL,
  localStorage: windowEl.localStorage,
  sessionStorage: windowEl.sessionStorage,
  fetch: () => Promise.resolve({ text: () => Promise.resolve(''), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
  GM_getValue: (k, d) => (k in sandbox.__gm ? sandbox.__gm[k] : d),
  GM_setValue: (k, v) => { sandbox.__gm[k] = v; },
  GM_xmlhttpRequest: (o) => { if (o.onerror) setTimeout(() => o.onerror(), 0); },
  __gm: {},
};
sandbox.globalThis = sandbox;
sandbox.self = windowEl;

try {
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'xuexitong-assistant.user.js', timeout: 8000 });
} catch (e) {
  failed = e;
}

if (failed) {
  console.log('FAIL 初始化抛异常：');
  console.log('  ' + failed.message);
  console.log(failed.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

// 跑几轮主循环，检查运行期不炸
let tickErr = null;
try {
  for (let i = 0; i < 3; i++) intervals.forEach((fn) => fn());
} catch (e) { tickErr = e; }

if (tickErr) {
  console.log('FAIL 主循环抛异常：');
  console.log('  ' + tickErr.message);
  console.log(tickErr.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

console.log('PASS 初始化与 3 轮主循环均无异常');
console.log('  setInterval 注册数: ' + intervals.length);
console.log('  GM 存储写入键: ' + Object.keys(sandbox.__gm).join(', '));
