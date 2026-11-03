// 答题质量改进的测试：题型标注 + 分数提取 + 投票
// 运行：node tests/ai-quality.test.js

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
    getContext() {
      return {
        font: '20px sans-serif', textBaseline: 'top', textAlign: 'left', fillStyle: '#000',
        clearRect() {}, fillText() {}, measureText() { return { width: 10 }; },
        getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
      };
    },
  };
}

// bodyText：页面正文（readWorkScore 从这里读成绩）
function boot(bodyText) {
  const bodyEl = makeEl('body');
  bodyEl.textContent = bodyText || '';
  const documentEl = {
    nodeType: 9, body: bodyEl, head: makeEl('head'), documentElement: makeEl('html'), title: '',
    fonts: { add() {}, ready: Promise.resolve() },
    styleSheets: [],
    createElement: (t) => makeEl(t),
    getElementById() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
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
    localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }, key(i) { return Object.keys(this._d)[i] ?? null; }, get length() { return Object.keys(this._d).length; } },
    sessionStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
    console: { log() {}, warn() {}, error() {} },
  };
  windowEl.self = windowEl;
  windowEl.top = windowEl;

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
  return windowEl.__CXAS_DEBUG;
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

// ============ 1. 题型标注（最关键：多选题不标注时模型常只给一个字母）============
console.log('[1] 题型标注进 prompt');
{
  const d = boot('');
  const opts = [{ text: '甲' }, { text: '乙' }, { text: '丙' }, { text: '丁' }];
  const pSingle = d.buildAiUserPrompt('测试题目', opts, 'single');
  const pMulti = d.buildAiUserPrompt('测试题目', opts, 'multiple');
  const pJudge = d.buildAiUserPrompt('测试题目', [{ text: '对' }, { text: '错' }], 'judge');
  const pFill = d.buildAiUserPrompt('请填空：___', [], 'fill');
  const pNone = d.buildAiUserPrompt('测试题目', opts, undefined);

  ok('single 带单选提示', /单选题/.test(pSingle), pSingle.split('\n')[0]);
  ok('multiple 明确要求"全部"', /多选题/.test(pMulti) && /全部|多个/.test(pMulti), pMulti.split('\n')[0]);
  ok('judge 说明只输出对/错', /判断题/.test(pJudge), pJudge.split('\n')[0]);
  ok('fill 说明 | 分隔', /填空题/.test(pFill) && /\|/.test(pFill), pFill.split('\n')[0]);
  ok('unknown 不加提示（不误导）', !/题型：/.test(pNone), pNone.split('\n')[0]);
  ok('题目与选项都在', /测试题目/.test(pSingle) && /A\. 甲/.test(pSingle) && /D\. 丁/.test(pSingle));
}

// ============ 2. 分数提取（唯一能验证准确率的真实信号）============
console.log('\n[2] 分数提取 readWorkScore');
const scoreCases = [
  ['本次成绩 80分', 80],
  ['本次成绩：85.5 分', 85.5],
  ['最终成绩 92', 92],
  ['得分：77分', 77],
  ['成绩 88/100', 88],
  ['本次成绩 0分', 0],
  ['本次成绩 100分', 100],
];
scoreCases.forEach(([text, want]) => {
  const d = boot(text);
  eq('"' + text + '" → ' + want, d.readWorkScore(), want);
});

console.log('\n[3] 分数提取：不该误判的情况');
[
  '本题共 10 分',
  '成绩单下载',
  '第 80 题',
  '总分 120 分',      // >100，应拒绝
].forEach((text) => {
  const d = boot(text);
  eq('"' + text + '" 不返回分数', d.readWorkScore(), null);
});

// ============ 4. 解析失败重试 / 投票配置存在性 ============
console.log('\n[4] 新增配置项');
{
  const d = boot('');
  eq('aiMaxTokens 已提到 256', d.cfg.aiMaxTokens, 256);
  eq('aiVoteSamples 默认 0（关闭，省 token）', d.cfg.aiVoteSamples, 0);
  eq('aiRetryOnParseFail 默认开', d.cfg.aiRetryOnParseFail, true);
  ok('prompt 含"多选题给全部"约束', /全部/.test(d.cfg.aiPrompt));
  ok('prompt 含"不确定也要给最可能"', /不确定/.test(d.cfg.aiPrompt));
  ok('askAIVote 已暴露', typeof d.askAIVote === 'function');
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
