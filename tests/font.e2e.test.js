// 端到端字体解码测试（直接调用脚本内的真实 FONT 模块）
// 用确定性 mock canvas 模拟"字体把码位 X 渲染成字符 Y 的字形"，
// 验证：字体检测 → TTF 下载 → cmap 解析 → FontFace → 基准池 → 字形匹配 → decode 还原
// 运行：node tests/font.e2e.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'xuexitong-assistant.user.js'), 'utf8');

// ---- 模拟的混淆表：码位字符 -> 真实显示的字形 ----
const SHUFFLE = {
  '甲': '人', '乙': '民', '丙': '国', '丁': '学',
  '戊': '习', '己': '通', '庚': '题', '辛': '目',
  '壬': '中', '癸': '文',
};

// 确定性图案：同一 (字符, 字体类别) => 同一图案
function patternFor(key) {
  const data = new Uint8ClampedArray(20 * 20 * 4);
  let h = 0;
  for (const c of key) h = (h * 131 + c.codePointAt(0)) >>> 0;
  for (let i = 0; i < 20 * 20; i++) {
    const v = ((h >>> (i % 24)) ^ (i * 2654435761)) & 0xff;
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v;
    data[i * 4 + 3] = v > 100 ? 255 : 0;
  }
  return { data };
}

// 字体类别：probe 字体渲染出"真实字形"，基准字体渲染自己的字形
function fontClass(fontSpec) {
  // t11/D：探测字体家族名已随机化（不再有 cxas_probe 前缀），
  // 所以"不是四个基准字体"的一律按 probe 处理。
  if (/SimSun/.test(fontSpec)) return 'sun';
  if (/SimHei/.test(fontSpec)) return 'hei';
  if (/Microsoft YaHei/.test(fontSpec)) return 'yahei';
  if (/sans-serif/.test(fontSpec)) return 'sans';
  return 'probe';
}

function makeCtx() {
  return {
    font: '20px sans-serif',
    textBaseline: 'top', textAlign: 'left', fillStyle: '#000',
    _lastChar: '',
    clearRect() {},
    fillText(ch) { this._lastChar = String(ch); },
    measureText() { return { width: 10 }; },
    getImageData() {
      const cls = fontClass(this.font);
      // probe 字体下，码位字符显示的是 SHUFFLE 里的真实字
      const shown = cls === 'probe' ? (SHUFFLE[this._lastChar] || this._lastChar) : this._lastChar;
      // 同一真实字在不同基准字体下略有差异（模拟真实字形），但 probe 应与某一基准字体高度一致
      return patternFor(shown);
    },
  };
}

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
    getContext() { return makeCtx(); },
  };
}

const fontFaceRule = {
  type: 5,
  constructor: { name: 'CSSFontFaceRule' },
  style: {
    getPropertyValue(prop) {
      if (prop === 'font-family') return "'font-cxsecret'";
      if (prop === 'src') return "url('https://p.ananas.chaoxing.com/star3/font-cxsecret.ttf') format('truetype')";
      return '';
    },
  },
};
const sheet = { cssRules: [fontFaceRule] };

// FontFaceSet 的最小实现：记录 add/delete，用来验证 t11/D「用完从 document.fonts 删除」
const fontSet = {
  _added: [],
  _deleted: [],
  add(face) { this._added.push(face); },
  delete(face) {
    const i = this._added.indexOf(face);
    if (i >= 0) this._added.splice(i, 1);
    this._deleted.push(face);
    return i >= 0;
  },
  ready: Promise.resolve(),
};

const bodyEl = makeEl('body');
const documentEl = {
  nodeType: 9, body: bodyEl, head: makeEl('head'), documentElement: makeEl('html'),
  fonts: fontSet,
  styleSheets: [sheet],
  createElement: (t) => makeEl(t),
  getElementById() { return null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  addEventListener() {}, removeEventListener() {},
};
const windowEl = {
  document: documentEl,
  location: { hostname: 'mooc1.chaoxing.com', pathname: '/work/test', href: 'https://x/', search: '' },
  self: null, top: null, frames: [],
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  addEventListener() {}, postMessage() {}, confirm: () => true, prompt: () => '',
  FontFace: class { constructor(f, s) { this.family = f; this.source = s; } load() { return Promise.resolve(this); } },
  setTimeout: (fn) => setTimeout(fn, 0),
  setInterval: () => 0, clearInterval() {},
  MutationObserver: class { observe() {} disconnect() {} },
  Blob: class {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }, key(i) { return Object.keys(this._d)[i] ?? null; }, get length() { return Object.keys(this._d).length; } },
  sessionStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
  console: { log() {}, warn() {}, error() {} },
};
windowEl.self = windowEl;
windowEl.top = windowEl;

const ttfBuf = fs.readFileSync('C:/Windows/Fonts/arial.ttf');
const ttfAB = ttfBuf.buffer.slice(ttfBuf.byteOffset, ttfBuf.byteOffset + ttfBuf.byteLength);

const sandbox = {
  window: windowEl, document: documentEl, unsafeWindow: windowEl, location: windowEl.location,
  console: { log() {}, warn() {}, error() {} },
  setTimeout: (fn) => setTimeout(fn, 0), setInterval: () => 0,
  clearTimeout: () => {}, clearInterval: () => {},
  MutationObserver: windowEl.MutationObserver, Blob: windowEl.Blob, URL: windowEl.URL,
  localStorage: windowEl.localStorage, sessionStorage: windowEl.sessionStorage,
  fetch: () => Promise.resolve({ text: () => Promise.resolve(''), arrayBuffer: () => Promise.resolve(ttfAB) }),
  // 预置 verbose，让脚本暴露调试钩子
  GM_getValue: (k, d) => (k === 'cfg' ? { verbose: true, debugBadge: true } : (k in sandbox.__gm ? sandbox.__gm[k] : d)),
  GM_setValue: (k, v) => { sandbox.__gm[k] = v; },
  GM_xmlhttpRequest: (o) => { setTimeout(() => o.onload({ response: ttfAB }), 0); },
  __gm: {},
};
sandbox.globalThis = sandbox;
sandbox.self = windowEl;

vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'user.js', timeout: 20000 });

const dbg = windowEl.__CXAS_DEBUG;
if (!dbg) {
  console.log('FAIL 未取到调试钩子 window.__CXAS_DEBUG');
  process.exit(1);
}
console.log('[1] 脚本加载成功，调试钩子可用（version=' + dbg.version + '）');

const FONT = dbg.font;
const found = FONT.findFontUrl();
console.log('[2] 字体检测：' + (found ? found.family + ' @ ' + found.url.slice(0, 60) + '…' : 'FAIL 未找到'));

(async () => {
  const encoded = Object.keys(SHUFFLE).join('');
  const expect = Object.values(SHUFFLE).join('');

  const prep = await FONT.prepare([encoded]);
  console.log('[3] prepare：' + JSON.stringify(prep));

  const h = FONT.health();
  console.log('[4] health：' + JSON.stringify(h));

  const decoded = FONT.decode(encoded);
  const passDecode = decoded === expect;
  console.log('[5] 解码还原：' + (passDecode ? 'PASS' : 'FAIL'));
  console.log('    输入(码位文本): ' + JSON.stringify(encoded));
  console.log('    期望(真实文本): ' + JSON.stringify(expect));
  console.log('    实得          : ' + JSON.stringify(decoded));

  // 混合文本：真实字 + 混淆字，验证只替换该替换的
  const mixed = '这是' + Object.keys(SHUFFLE).slice(0, 3).join('') + '的内容';
  const mixedExpect = '这是' + Object.values(SHUFFLE).slice(0, 3).join('') + '的内容';
  const mixedGot = FONT.decode(mixed);
  const passMixed = mixedGot === mixedExpect;
  console.log('[6] 混合文本：' + (passMixed ? 'PASS' : 'FAIL') + '  ' + JSON.stringify(mixedGot));

  const blocked = FONT.blocked();
  console.log('[7] blocked（是否因解码失败拒绝答题）：' + blocked);

  // t11/D：探测字体指纹
  const fam = FONT.family() || '';
  const faceState = FONT.faceState();
  const famRandom = /^20px "p[a-z0-9]+"/.test(fam) && !/cxas/i.test(fam);
  const noResidue = fontSet._added.length === 0 && fontSet._deleted.length >= 1;
  console.log('[8] 探测字体家族名：' + JSON.stringify(fam) + '  （随机且无 cxas 前缀：' + famRandom + '）');
  console.log('[9] document.fonts：残留=' + fontSet._added.length +
    ' 删除次数=' + fontSet._deleted.length + '  （用完即删：' + noResidue + '）');
  console.log('    faceState=' + JSON.stringify(faceState));

  if (!found || !passDecode || !passMixed || blocked || !famRandom || !noResidue) {
    console.log('\nFAIL 端到端解码未全部通过（含探测字体指纹断言）');
    process.exit(1);
  }
  console.log('\nPASS 端到端解码链路全部通过（真实 FONT 模块）');
})();
