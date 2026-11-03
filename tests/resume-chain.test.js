// v3.2 新功能单测：断点续刷（chapterId 解析 + 跳回行为）+ 课程链（courseId 解析）
// 运行：node tests/resume-chain.test.js
//
// 为什么单测：
//   ① chapterId 解析有三种来源（URL / toOld onclick / #cur{id}），错一种就会跳到别的节，
//      而且**跳错不报错**——只有真跑到别的章节才会发现，代价是白刷一节。
//   ② 断点续刷最怕"过期还跳"和"已经在这节还跳"，两者都会造成无谓跳转（最容易触发风控）。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'xuexitong-assistant.user.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name + ' → ' + g, g === w, g === w ? '' : '期望 ' + w);
}

function makeEl(tag, attrs) {
  const a = attrs || {};
  const el = {
    tagName: (tag || 'div').toUpperCase(), nodeType: 1,
    style: {}, children: [], parentElement: null,
    id: a.id || '', className: a.className || '', textContent: a.textContent || '',
    _attrs: a.attrs || {},
    clicked: 0,
    classList: { _s: new Set(String(a.className || '').split(/\s+/).filter(Boolean)), contains(c) { return this._s.has(c); } },
    getAttribute(k) { return this._attrs[k] === undefined ? null : this._attrs[k]; },
    setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    click() { this.clicked++; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, cloneNode() { return makeEl(this.tagName); },
    getBoundingClientRect() { return { width: 100, height: 50, top: 0, left: 0 }; },
    getContext() { return { clearRect() {}, fillText() {}, measureText() { return { width: 10 }; }, getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; } }; },
  };
  return el;
}

/* opts:
 *   nodes    目录节点数组（元素）
 *   href     当前页面地址（决定 currentChapterId 走 URL 分支）
 *   resume   预置的 GM 断点记录 {id, at}
 */
function boot(opts) {
  const o = opts || {};
  const bodyEl = makeEl('body');
  const documentEl = {
    nodeType: 9, body: bodyEl, head: makeEl('head'), documentElement: makeEl('html'), title: '',
    fonts: { add() {}, ready: Promise.resolve() }, styleSheets: [],
    createElement: (t) => makeEl(t), getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll(s) {
      if (s === '.chapter_item, .posCatalog_select, a') return o.nodes || [];
      return [];
    },
    addEventListener() {}, removeEventListener() {},
  };
  const href = o.href || 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=111&courseId=222';
  const windowEl = {
    document: documentEl,
    location: { hostname: 'mooc1.chaoxing.com', pathname: '/mycourse/studentstudy', href: href, search: href.replace(/^[^?]*/, '') },
    self: null, top: null, frames: [],
    history: { length: 2, back() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    addEventListener() {}, postMessage() {}, confirm: () => true, prompt: () => '',
    FontFace: class { load() { return Promise.resolve(this); } },
    setTimeout: (fn) => setTimeout(fn, 0), setInterval: () => 0, clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    Blob: class {}, URL: { createObjectURL: () => 'b', revokeObjectURL() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, key() { return null; }, length: 0 },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    console: { log() {}, warn() {}, error() {} },
  };
  windowEl.self = windowEl; windowEl.top = windowEl;

  const gm = {};
  if (o.resume) gm['resume_v1'] = o.resume;
  const sandbox = {
    window: windowEl, document: documentEl, unsafeWindow: windowEl, location: windowEl.location,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => setTimeout(fn, 0), setInterval: () => 0,
    clearTimeout: () => {}, clearInterval: () => {},
    MutationObserver: windowEl.MutationObserver, Blob: windowEl.Blob, URL: windowEl.URL,
    localStorage: windowEl.localStorage, sessionStorage: windowEl.sessionStorage,
    fetch: () => Promise.resolve({ text: () => Promise.resolve(''), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
    GM_getValue: (k, d) => (k === 'cfg' ? { verbose: true } : (k in gm ? gm[k] : d)),
    GM_setValue: (k, v) => { gm[k] = v; },
    GM_xmlhttpRequest: (o2) => { if (o2.onerror) setTimeout(() => o2.onerror(), 0); },
    __gm: gm,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = windowEl;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'user.js', timeout: 15000 });
  return { debug: windowEl.__CXAS_DEBUG, gm: gm, nodes: o.nodes || [] };
}

// ============ 1. chapterId 三种来源解析 ============
console.log('[1] chapterId 解析');
{
  const d = boot({}).debug;
  eq('URL 里取 chapterId', d.chapterIdFromUrl('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=987654321&courseId=123456789'), '987654321');
  eq('URL 没参数时为空', d.chapterIdFromUrl('https://mooc1.chaoxing.com/x'), '');

  const nodeToOld = makeEl('div', { attrs: { onclick: "toOld('123456789','987654321','111222333',0)" } });
  eq('toOld() 取第 2 个参数', d.chapterIdOfNode(nodeToOld), '987654321');

  const nodeCur = makeEl('div', { id: 'cur987654321' });
  eq('#cur{id} 取 id 里的数字', d.chapterIdOfNode(nodeCur), '987654321');

  const nodeKn = makeEl('div', { attrs: { onclick: "openChapter('x','knowledgeId=987654321')" } });
  eq('knowledgeId= 形态', d.chapterIdOfNode(nodeKn), '987654321');

  const nodeNone = makeEl('div', { attrs: { onclick: 'void(0)' } });
  eq('无法识别时返回空（不瞎猜）', d.chapterIdOfNode(nodeNone), '');

  eq('courseId 解析', d.courseIdOfHref('https://x/entercoursenewfy?role=3&courseId=123456789&clazzId=1'), '123456789');
}

// ============ 2. 断点续刷：该跳的时候跳 ============
console.log('[2] 断点续刷行为');
{
  const target = makeEl('div', {
    className: 'chapter_item', textContent: '1.4 教学视频',
    attrs: { onclick: "toOld('123456789','987654321','111222333',0)" },
  });
  // 当前 URL 是别的章节，断点是上面那一节 → 应跳
  const ctx = boot({
    nodes: [target],
    href: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=999&courseId=123456789',
    resume: { id: '987654321', at: Date.now() },
  });
  ok('跳回了断点小节', target.clicked === 1, 'clicked=' + target.clicked);
  ok('面板写明原因', /断点续刷/.test(ctx.debug.stats.lastAction || ''), ctx.debug.stats.lastAction);
}

// ============ 3. 已经在这一节：不该跳 ============
console.log('[3] 已在本节不要重复跳');
{
  const target = makeEl('div', {
    className: 'chapter_item',
    attrs: { onclick: "toOld('123456789','987654321','111222333',0)" },
  });
  boot({
    nodes: [target],
    href: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=987654321&courseId=123456789',
    resume: { id: '987654321', at: Date.now() },
  });
  ok('同节不跳', target.clicked === 0, 'clicked=' + target.clicked);
}

// ============ 4. 断点过期：不该跳 ============
console.log('[4] 过期断点不跳（避免几天后突然跳旧节）');
{
  const target = makeEl('div', {
    className: 'chapter_item',
    attrs: { onclick: "toOld('123456789','987654321','111222333',0)" },
  });
  boot({
    nodes: [target],
    href: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=999&courseId=123456789',
    resume: { id: '987654321', at: Date.now() - 20 * 3600 * 1000 },   // 20 小时前 > 12 小时上限
  });
  ok('过期不跳', target.clicked === 0, 'clicked=' + target.clicked);
}

// ============ 5. 目录里找不到该节：不跳也不崩 ============
console.log('[5] 目录里没有该小节');
{
  const other = makeEl('div', { className: 'chapter_item', attrs: { onclick: "toOld('1','555','2',0)" } });
  const ctx = boot({
    nodes: [other],
    href: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=999&courseId=123456789',
    resume: { id: '987654321', at: Date.now() },
  });
  ok('未命中则不点任何节点', other.clicked === 0, 'clicked=' + other.clicked);
  ok('没有抛异常（stats 仍可读）', typeof ctx.debug.stats === 'object');
}

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
