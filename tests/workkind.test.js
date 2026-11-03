// 题目页类型识别测试：决定"敢不敢自动提交"的关键判断
// 运行：node tests/workkind.test.js

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

// 每次测试重建 sandbox，用不同的 title / href
function boot(opts) {
  const bodyEl = makeEl('body');
  const titleEl = opts.titleText ? makeEl('div') : null;
  if (titleEl) titleEl.textContent = opts.titleText;

  const documentEl = {
    nodeType: 9, body: bodyEl, head: makeEl('head'), documentElement: makeEl('html'),
    title: opts.title || '',
    fonts: { add() {}, ready: Promise.resolve() },
    styleSheets: [],
    createElement: (t) => makeEl(t),
    getElementById() { return null; },
    querySelector(sel) {
      if (titleEl && /mark_title|workTitle|mark_name|h1|\.title/.test(sel)) return titleEl;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
  const windowEl = {
    document: documentEl,
    location: { hostname: 'mooc1.chaoxing.com', pathname: opts.path || '/', href: opts.href || 'https://mooc1.chaoxing.com/', search: opts.search || '' },
    self: null, top: null, frames: [],
    history: { length: 2, back() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    addEventListener() {}, postMessage() {}, confirm: () => true, prompt: () => '',
    FontFace: class { constructor(f, s) { this.family = f; this.source = s; } load() { return Promise.resolve(this); } },
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
  if (got === want) { pass++; console.log('  ok   ' + name + ' → ' + got); }
  else { fail++; console.log('  FAIL ' + name + ' → 实得 ' + got + '，期望 ' + want); }
}

console.log('[题目页类型识别]');
eq('标题含"章节测验"', boot({ title: '章节测验 - 学习通' }).detectWorkKind(), 'quiz');
eq('标题含"测验"', boot({ title: '第3章 测验' }).detectWorkKind(), 'quiz');
eq('标题含"作业"', boot({ title: '第2次作业' }).detectWorkKind(), 'homework');
eq('标题含"考试"', boot({ title: '期末考试' }).detectWorkKind(), 'exam');
eq('URL 含 /exam/', boot({ href: 'https://mooc1.chaoxing.com/exam/test/reVersionTestStartNew' }).detectWorkKind(), 'exam');
eq('URL 含 /work/ 无标题线索', boot({ href: 'https://mooc1.chaoxing.com/work/doHomeWorkNew?x=1' }).detectWorkKind(), 'work');
eq('普通视频页', boot({ href: 'https://mooc1.chaoxing.com/mycourse/studentstudy?x=1' }).detectWorkKind(), 'unknown');
eq('标题元素含"章节测验"', boot({ title: '', titleText: '第1章 章节测验' }).detectWorkKind(), 'quiz');

console.log('\n[提交安全性：哪些类型允许自动提交]');
function canAutoSubmit(kind, cfg) {
  // 复现脚本里的判定表
  const C = Object.assign({ autoSubmitQuiz: true, autoSubmitWork: false, autoSubmitExam: false, safeMode: true }, cfg || {});
  if (kind === 'exam') return false;
  if (kind === 'quiz') return !!C.autoSubmitQuiz;
  if (kind === 'homework') return !!C.autoSubmitWork && !C.safeMode;
  return false; // work / unknown
}
eq('测验 → 允许（可重做）', canAutoSubmit('quiz', {}), true);
eq('作业 → 默认禁止', canAutoSubmit('homework', {}), false);
eq('作业 → 关安全模式+开开关才允许', canAutoSubmit('homework', { autoSubmitWork: true, safeMode: false }), true);
eq('作业 → 开开关但安全模式仍禁止', canAutoSubmit('homework', { autoSubmitWork: true, safeMode: true }), false);
eq('考试 → 永远禁止', canAutoSubmit('exam', { autoSubmitWork: true, safeMode: false }), false);
eq('未知类型 → 禁止', canAutoSubmit('unknown', { autoSubmitQuiz: true, safeMode: false }), false);

console.log('\n[题型识别 detectQuestionType（t4）]');
// 题型识别的假题目块：只实现脚本用到的 querySelector / querySelectorAll / getAttribute
// trustedText → .newZy_TItle/.colorShallow（可信题型行）；weakText → .TiMuTitle/.mark_name（题干，需守卫）
function qblock(o) {
  o = o || {};
  const mk = (t) => { const el = makeEl('span'); el.textContent = t; return el; };
  const trustedEl = o.trustedText !== undefined ? mk(o.trustedText)
    : (o.titleText !== undefined ? mk(o.titleText) : null);
  const weakEl = o.weakText !== undefined ? mk(o.weakText) : null;
  const options = (o.options || []).map((t, i) => {
    const el = makeEl('li');
    el.textContent = t;
    el.getAttribute = (k) => (o.optionRoles && o.optionRoles[i] && k === 'role' ? o.optionRoles[i] : null);
    el.querySelector = (sel) => (o.checkbox && /checkbox/.test(String(sel)) ? makeEl('input') : null);
    return el;
  });
  const areas = o.areas ? Array.from({ length: o.areas }, () => makeEl('textarea')) : [];
  const el = makeEl('div');
  el.textContent = o.titleText || o.weakText || '';
  el.getAttribute = (k) => (o.attrs && o.attrs[k] !== undefined ? String(o.attrs[k]) : null);
  el.querySelector = (sel) => {
    const s = String(sel);
    if (/newZy_TItle|colorShallow/.test(s)) return trustedEl;
    if (/TiMuTitle|mark_name/.test(s)) return weakEl;
    return null;
  };
  el.querySelectorAll = (sel) => {
    const s = String(sel);
    if (/textarea|contenteditable/.test(s)) return areas;
    if (/li|option|before-after|Zy_ulTop/.test(s)) return options;
    return [];
  };
  return el;
}

const W = boot({ title: '章节测验' });
function ttype(name, blk, wantType, wantSource) {
  const r = W.detectQuestionType(blk);
  eq(name + ' → ' + r.type + '/' + r.source + (r.type === wantType && r.source === wantSource ? '' : '（期望 ' + wantType + '/' + wantSource + '）'),
    r.type + '/' + r.source, wantType + '/' + wantSource);
}

// t24：标签匹配改为"整段相等"，所以这里必须是**纯标签**（不能带题干文字）
ttype('文字【单选题】', qblock({ trustedText: '【单选题】' }), 'single', 'text');
ttype('文字【多选题】', qblock({ trustedText: '【多选题】' }), 'multiple', 'text');
ttype('文字【判断题】', qblock({ trustedText: '【判断题】' }), 'judge', 'text');
ttype('文字【填空题】', qblock({ trustedText: '【填空题】' }), 'fill', 'text');
ttype('文字【简答题】', qblock({ trustedText: '【简答题】' }), 'subjective', 'text');
ttype('文字【名词解释】', qblock({ trustedText: '【名词解释题】' }), 'subjective', 'text');
ttype('文字【论述题】', qblock({ trustedText: '【论述题】' }), 'subjective', 'text');
ttype('文字【计算题】', qblock({ trustedText: '【计算题】' }), 'calc', 'text');
// t24：可信来源也走同一套严格正则——"【单选题】+ 题干文字"不再算标签
ttype('可信来源带题干文字（【单选题】HTTP 端口）→ 不采用',
  qblock({ trustedText: '【单选题】HTTP 端口' }), 'unknown', 'none');
ttype('可信来源带题干文字 + 4 选项 → 靠结构',
  qblock({ trustedText: '【单选题】HTTP 端口', options: ['甲', '乙', '丙', '丁'] }), 'single', 'structure');
ttype('数字码 data=0（无文字，最后兜底）', qblock({ attrs: { data: '0' } }), 'single', 'data');
ttype('数字码 data=3（最后兜底）', qblock({ attrs: { data: '3' } }), 'judge', 'data');
ttype('作业 typename=7（可信数字码）', qblock({ attrs: { typename: '7' } }), 'calc', 'typename');
ttype('文字优先于数字码（多选标签 + data=0）',
  qblock({ trustedText: '【多选题】', attrs: { data: '0' } }), 'multiple', 'text');
ttype('结构：两选项且是 对/错', qblock({ options: ['对', '错'] }), 'judge', 'structure');
ttype('结构：两选项但不是对错 → 单选', qblock({ options: ['甲', '乙'] }), 'single', 'structure');
ttype('结构：checkbox 选项 → 多选', qblock({ options: ['A', 'B', 'C'], checkbox: true }), 'multiple', 'structure');
ttype('结构：纯 textarea → 主观', qblock({ areas: 1 }), 'subjective', 'structure');
ttype('结构：无任何输入 → unknown', qblock({}), 'unknown', 'none');

console.log('\n[F1：题干里的题型词不能把题判歪（t22）]');
// 这四条的题干都放在 .mark_name（同一文件里 parseWorkQuestions 也把它当题干），
// data=0 + 4 个普通选项 → 必须靠结构判成 single，绝不能判成 calc/subjective/fill/judge
const stemOpts = ['甲', '乙', '丙', '丁'];
ttype('题干「以下关于计算机网络的描述」+4 选项',
  qblock({ weakText: '以下关于计算机网络的描述，正确的是？', attrs: { data: '0' }, options: stemOpts }), 'single', 'structure');
ttype('题干「论述 HTTP/2 的优缺点」+4 选项',
  qblock({ weakText: '论述 HTTP/2 的优缺点', attrs: { data: '0' }, options: stemOpts }), 'single', 'structure');
ttype('题干「请填空：TCP 端口」+4 选项',
  qblock({ weakText: '请填空：TCP 端口', attrs: { data: '0' }, options: stemOpts }), 'single', 'structure');
ttype('题干「判断下列说法是否正确」+4 选项',
  qblock({ weakText: '判断下列说法是否正确', attrs: { data: '0' }, options: stemOpts }), 'single', 'structure');
// 守卫的正例：括号内 / 开头带题号的题型词仍然采用
ttype('可信来源「【单选题】」', qblock({ trustedText: '【单选题】' }), 'single', 'text');
ttype('弱来源「1.（单选题）」', qblock({ weakText: '1.（单选题）' }), 'single', 'text');
ttype('弱来源「（多选题）」', qblock({ weakText: '（多选题）' }), 'multiple', 'text');
ttype('弱来源「1、【判断题】」', qblock({ weakText: '1、【判断题】' }), 'judge', 'text');

console.log('\n[F2：复合题型词（t22）]');
ttype('单项选择题', qblock({ trustedText: '单项选择题' }), 'single', 'text');
ttype('多项选择题', qblock({ trustedText: '多项选择题' }), 'multiple', 'text');
ttype('是非题', qblock({ trustedText: '是非题' }), 'judge', 'text');
ttype('判断题', qblock({ trustedText: '判断题' }), 'judge', 'text');

console.log('\n[F3：判断题结构词表（t22）]');
ttype('两选项 是/否', qblock({ options: ['是', '否'] }), 'judge', 'structure');
ttype('两选项 True/False', qblock({ options: ['True', 'False'] }), 'judge', 'structure');
ttype('两选项 A对/B错', qblock({ options: ['A对', 'B错'] }), 'judge', 'structure');

console.log('\n[F4：.TiMu[data] 只在结构判不出时才兜底（t22）]');
ttype('data=2 + 两个 textarea → 结构优先判主观（不用推测码）',
  qblock({ attrs: { data: '2' }, areas: 2 }), 'subjective', 'structure');
ttype('data=3 + 无输入 → 兜底判断题',
  qblock({ attrs: { data: '3' } }), 'judge', 'data');
ttype('typename=3 优先于 data=0（typename 更可信）',
  qblock({ attrs: { typename: '3', data: '0' } }), 'judge', 'typename');

console.log('\n[t24：题型标签严格整体匹配（LABEL_RE）——模糊测试]');
// 共同点：题型词出现在**非标签位置**（括号里/句子中）。旧实现用 includes 会误判，
// 新实现必须一条都不采用（source 不能是 text），退回结构 → single。
const fuzzyStems = [
  '以下（计算机网络）的说法，正确的是？',
  '关于（计算机算法）的描述',
  '（填空）以下说法正确的是',
  '下列（判断）是否成立',
  '请（简述）TCP 三次握手',
  '下列（选择）题中，错误的是',
  '（多选）以下哪些属于面向对象特征',
  '计算（1+1）的结果',
  '论述（HTTP/2）的优缺点',
  '判断（A）是否正确',
  '（单选）以下哪个不是传输层协议',
  '关于（论述）题的作答要求',
  '请写出（计算）过程',
  '（名词解释）是什么意思',
  '以下（翻译）是否准确',
  '用（连线）方式匹配',
  '关于（分录）的编制方法',
  '（简答）以下问题',
  '下列说法（正确）的是',
  '下列（是非）判断正确的是',
  '计算机网络的（选择）策略',
  '（计算题）的计算方法',
  '请（填空）完成句子',
  '关于（判断题）的评分标准',
  '计算（2分）的结果',
];
let misjudged = 0;
fuzzyStems.forEach((s) => {
  const r = W.detectQuestionType(
    qblock({ weakText: s, attrs: { data: '0' }, options: ['甲', '乙', '丙', '丁'] })
  );
  if (r.source === 'text') misjudged++;
  eq('干扰题干不被当标签：' + s, r.type + '/' + r.source, 'single/structure');
});
eq('25 条干扰题干无一被误判为题型文字', misjudged, 0);

// 可信来源同样严格（同一套正则）
eq('可信来源「（计算机网络）」不算标签',
  (function () {
    const r = W.detectQuestionType(qblock({ trustedText: '（计算机网络）', options: ['甲', '乙', '丙', '丁'] }));
    return r.type + '/' + r.source;
  })(), 'single/structure');

console.log('\n[t24：正向不能退化（整段标签 / 题号 / 括号 / 分值）]');
ttype('整段「单选题」', qblock({ trustedText: '单选题' }), 'single', 'text');
ttype('整段「单项选择题」', qblock({ trustedText: '单项选择题' }), 'single', 'text');
ttype('【单选题】（2分）', qblock({ trustedText: '【单选题】（2分）' }), 'single', 'text');
ttype('1. 判断题（2分）', qblock({ weakText: '1. 判断题（2分）' }), 'judge', 'text');
ttype('1、多选题', qblock({ weakText: '1、多选题' }), 'multiple', 'text');
ttype('（名词解释题）', qblock({ weakText: '（名词解释题）' }), 'subjective', 'text');

console.log('\n[题型策略开关 typeAllowed（t4）]');
eq('客观题默认允许', W.typeAllowed('single') && W.typeAllowed('multiple') && W.typeAllowed('judge'), true);
eq('填空默认允许', W.typeAllowed('fill'), true);
eq('简答默认不作答', W.typeAllowed('subjective'), false);
eq('计算默认不作答', W.typeAllowed('calc'), false);
eq('unknown 永不猜', W.typeAllowed('unknown'), false);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
