// 每日上限 / 分天完成（板块④，t8）单元测试
// 运行：node tests/daily.test.js
//
// 覆盖：
//   · 跨天重置（注入 now，不依赖真实时钟）
//   · dailyTaskLimit: 0 = 不限
//   · 计数只在「平台完成标记出现」时 +1，同一节不重复计
//   · .jobCountDiv + 文案 + 可见 三条件**同时**满足才命中
//   · 日期边界用本地时间（用本地 23:59 / 次日 00:01 断言，避开 UTC 陷阱）

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'xuexitong-assistant.user.js'), 'utf8');

function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(), nodeType: 1,
    style: { cssText: '', setProperty() {}, getPropertyValue() { return ''; } },
    children: [], parentElement: null, id: '', className: '', textContent: '', value: '',
    files: [], classList: { _s: [], add(c) { this._s.push(c); }, remove() {}, contains(c) { return this._s.indexOf(c) >= 0; } },
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

// 假文档：querySelectorAll 按 selector 返回预置元素，用于 platformDailyLimitHit / sectionCompleted
function fakeDoc(opts) {
  const o = opts || {};
  const doc = {
    nodeType: 9, body: makeEl('body'), head: makeEl('head'), documentElement: makeEl('html'),
    title: '', fonts: { add() {}, ready: Promise.resolve() }, styleSheets: [],
    createElement: (t) => makeEl(t),
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll(sel) {
      const s = String(sel);
      if (/jobCountDiv/.test(s)) return o.jobCountDivs || [];
      if (/chapter_item/.test(s)) return o.catalogNodes || [];
      if (/icon_Completed|orangeNew|ans-job-finished/.test(s)) return o.marks || [];
      return [];
    },
    addEventListener() {}, removeEventListener() {},
  };
  return doc;
}

function boot(opts) {
  opts = opts || {};
  const documentEl = opts.doc || fakeDoc();
  const windowEl = {
    document: documentEl,
    location: { hostname: 'mooc1.chaoxing.com', pathname: '/', href: 'https://mooc1.chaoxing.com/mycourse/studentstudy', search: '' },
    self: null, top: null, frames: [],
    history: { length: 2, back() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    addEventListener() {}, postMessage() {}, confirm: () => true, prompt: () => '',
    FontFace: class { constructor(f, s) { this.family = f; this.source = s; } load() { return Promise.resolve(this); } },
    setTimeout: (fn) => setTimeout(fn, 0), setInterval: () => 0, clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    Blob: class {}, URL: { createObjectURL: () => 'b', revokeObjectURL() {} },
    localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
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
    GM_getValue: (k, d) => (k === 'cfg' ? Object.assign({ verbose: true }, opts.cfg || {}) : (k in sandbox.__gm ? sandbox.__gm[k] : d)),
    GM_setValue: (k, v) => { sandbox.__gm[k] = v; },
    GM_xmlhttpRequest: (o) => { if (o.onerror) setTimeout(() => o.onerror(), 0); },
    __gm: {},
  };
  sandbox.globalThis = sandbox;
  sandbox.self = windowEl;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'user.js', timeout: 15000 });
  return { W: windowEl.__CXAS_DEBUG, sandbox, windowEl, documentEl };
}

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name + ' → ' + g); }
  else { fail++; console.log('  FAIL ' + name + ' → 实得 ' + g + '，期望 ' + w); }
}

// 本地时间构造：不用 toISOString，避免时区差异
function localMs(y, m, d, hh, mm) {
  return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0).getTime();
}

console.log('[1] 本地日期 key（不用 toISOString）');
{
  const { W } = boot();
  eq('2026-10-31 23:59 的 key', W.DAILY.todayKey(localMs(2026, 10, 31, 23, 59)), '2026-10-31');
  eq('2026-11-01 00:01 的 key（跨天）', W.DAILY.todayKey(localMs(2026, 11, 1, 0, 1)), '2026-11-01');
}

console.log('\n[2] 计数：只在完成标记出现时 +1，同一节不重复计');
{
  const { W } = boot();
  const t1 = localMs(2026, 10, 31, 10, 0);
  eq('初始为 0', W.DAILY.state(t1).count, 0);
  const a = W.DAILY.markSection('sec:第1节', t1);
  eq('第1节第一次计到 → counted=true', a.counted, true);
  eq('计数 1', a.rec.count, 1);
  const b = W.DAILY.markSection('sec:第1节', t1);   // 同一节再来一次
  eq('同一节重复 → counted=false（dup）', b.counted, false);
  eq('重复后计数仍为 1', b.rec.count, 1);
  const c = W.DAILY.markSection('sec:第2节', t1);
  eq('第2节 → 计数 2', c.rec.count, 2);
  eq('没有章节标识 → 不计数', W.DAILY.markSection('', t1).counted, false);
}

console.log('\n[3] 跨天重置（注入 now，不依赖真实时钟）');
{
  const { W } = boot();
  const d1 = localMs(2026, 10, 31, 23, 50);
  const d2 = localMs(2026, 11, 1, 0, 10);
  W.DAILY.markSection('sec:a', d1);
  W.DAILY.markSection('sec:b', d1);
  eq('day1 计数 2', W.DAILY.state(d1).count, 2);
  eq('day2 计数归零', W.DAILY.state(d2).count, 0);
  eq('day2 的 date 变了', W.DAILY.state(d2).date, '2026-11-01');
  W.DAILY.markSection('sec:c', d2);
  eq('day2 重新从 1 开始', W.DAILY.state(d2).count, 1);
  // 回到 day1 的"时间旅行"读到的仍是新记录（日期 key 不同 → 归零）
  eq('时间回拨不会读到旧记录（按日期 key 判定）', W.DAILY.state(d1).count, 0);
}

console.log('\n[4] dailyTaskLimit: 0 = 不限；正数才生效');
{
  const { W } = boot();
  const t = localMs(2026, 10, 31, 12, 0);
  eq('默认 0 → limitOf=0', W.DAILY.limitOf(), 0);
  W.DAILY.markSection('s1', t);
  W.DAILY.markSection('s2', t);
  eq('不限模式下 2 个也不触发', W.DAILY.limitReached(t), false);

  const { W: W2, sandbox: sb2 } = boot();
  W2.cfg.dailyTaskLimit = 2;
  const t2 = localMs(2026, 10, 31, 12, 0);
  eq('limits=2 时初始未达', W2.DAILY.limitReached(t2), false);
  W2.DAILY.markSection('s1', t2);
  eq('1 个未达', W2.DAILY.limitReached(t2), false);
  W2.DAILY.markSection('s2', t2);
  eq('2 个达到上限', W2.DAILY.limitReached(t2), true);
  eq('state 里 reached=true 且带 limit', W2.DAILY.state(t2).reached && W2.DAILY.state(t2).limit === 2, true);

  // 存储 key 必须是独立的 cxas_daily（GM 环境下就是 GM_key 'cxas_daily'）
  eq('GM 存储里有独立的 cxas_daily 记录', !!(sb2.__gm && sb2.__gm.cxas_daily), true);
  eq('cxas_daily 的 count 是 2', (sb2.__gm && sb2.__gm.cxas_daily && sb2.__gm.cxas_daily.count) || 0, 2);
  eq('cxas_daily 不含 epoch/jump_guard 字段', Object.keys((sb2.__gm && sb2.__gm.cxas_daily) || {}).sort().join(','), 'count,date,sections');
}

console.log('\n[5] 平台日上限：三条件必须同时满足');
{
  // ① 三条件全满足 → 命中
  const visibleEl = makeEl('div');
  visibleEl.textContent = '今日视频任务点完成数已达上限，您可以观看视频，但无法完成任务点';
  let { W } = boot({ doc: fakeDoc({ jobCountDivs: [visibleEl] }) });
  eq('元素存在 + 文案匹配 + 可见 → true', W.platformDailyLimitHit(), true);

  // ② 文案不匹配 → 不命中
  const wrongText = makeEl('div');
  wrongText.textContent = '今日已完成 3 个任务点';
  ({ W } = boot({ doc: fakeDoc({ jobCountDivs: [wrongText] }) }));
  eq('文案不匹配 → false', W.platformDailyLimitHit(), false);

  // ③ 不可见（宽高 0）→ 不命中
  const hiddenEl = makeEl('div');
  hiddenEl.textContent = '今日视频任务点完成数已达上限，您可以观看视频，但无法完成任务点';
  hiddenEl.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0 });
  ({ W } = boot({ doc: fakeDoc({ jobCountDivs: [hiddenEl] }) }));
  eq('不可见 → false', W.platformDailyLimitHit(), false);

  // ④ 元素不存在 → 不命中
  ({ W } = boot({ doc: fakeDoc({ jobCountDivs: [] }) }));
  eq('元素不存在 → false', W.platformDailyLimitHit(), false);

  // ⑤ 配置关掉 → 即使三条件满足也不命中
  const el5 = makeEl('div');
  el5.textContent = '今日视频任务点完成数已达上限，您可以观看视频，但无法完成任务点';
  ({ W } = boot({ doc: fakeDoc({ jobCountDivs: [el5] }), cfg: { detectPlatformDailyLimit: false } }));
  eq('detectPlatformDailyLimit=false → false', W.platformDailyLimitHit(), false);
}

console.log('\n[6] 完成标记：只认当前节的 .icon_Completed，别的节不算');
{
  const cur = makeEl('div');
  cur.classList.add('currents');
  cur.textContent = '第1节 视频';
  const done = makeEl('i');
  done.className = 'icon_Completed';
  cur.querySelector = (sel) => (/icon_Completed/.test(String(sel)) ? done : null);

  const other = makeEl('div');
  other.textContent = '第2节 视频';   // 非 current，没有完成图标

  let { W } = boot({ doc: fakeDoc({ catalogNodes: [cur, other] }) });
  eq('当前节有明显完成图标 → true', W.sectionCompleted(), true);

  // 其它节有完成图标、当前节没有 → 必须 false
  const cur2 = makeEl('div');
  cur2.classList.add('currents');
  cur2.textContent = '第2节 视频';
  cur2.querySelector = () => null;
  ({ W } = boot({ doc: fakeDoc({ catalogNodes: [cur2, done] }) }));
  eq('只有别的节完成 → false（不会数错）', W.sectionCompleted(), false);

  // 旧版：当前节带 .orangeNew 未完成标记 → false
  const cur3 = makeEl('div');
  cur3.classList.add('currents');
  const orange = makeEl('i');
  orange.className = 'orangeNew';
  cur3.querySelector = (sel) => {
    if (/orangeNew/.test(String(sel))) return orange;
    return null;
  };
  ({ W } = boot({ doc: fakeDoc({ catalogNodes: [cur3] }) }));
  eq('当前节带 orangeNew（未完成）→ false', W.sectionCompleted(), false);
}

console.log('\n[7] tickDaily 联动：完成标记出现才 +1，同一节只计一次（第一次 tick 只做基线）');
{
  const cur = makeEl('div');
  cur.classList.add('currents');
  cur.textContent = '第1节 视频';
  let completed = false;                      // 可切换：模拟"先没完成、后来完成"
  cur.querySelector = (sel) => (/icon_Completed/.test(String(sel))
    ? (completed ? makeMark() : null) : null);
  function makeMark() { const i = makeEl('i'); i.className = 'icon_Completed'; return i; }

  const { W } = boot({ doc: fakeDoc({ catalogNodes: [cur] }) });
  W.tickDaily();                               // t28/F2：第一次 tick 只做基线
  eq('基线 tick 不计数', W.stats.dailyCount, 0);
  W.tickDaily();
  eq('未出现完成标记时仍为 0', W.stats.dailyCount, 0);
  completed = true;
  W.tickDaily();
  eq('完成标记出现 → 计数 1', W.stats.dailyCount, 1);
  W.tickDaily();
  W.tickDaily();
  eq('连续 tick 不重复计 → 仍为 1', W.stats.dailyCount, 1);
  eq('section key 基于当前节文本', W.currentSectionKey(), 'sec:第1节视频');
}

console.log('\n[7b] t28/F2：启动时就已完成的节（昨天看完/回看老节）不计入今日');
{
  const cur = makeEl('div');
  cur.classList.add('currents');
  cur.textContent = '第0节 昨天看完的';
  const done = makeEl('i');
  done.className = 'icon_Completed';
  cur.querySelector = (sel) => (/icon_Completed/.test(String(sel)) ? done : null);

  const { W } = boot({ doc: fakeDoc({ catalogNodes: [cur] }) });
  W.tickDaily();                               // 基线：发现启动时已完成 → 记进 preCompleted
  eq('基线识别为"启动时已完成"', W.stats.dailyCount, 0);
  W.tickDaily();
  W.tickDaily();
  eq('历史完成的节永远不会被算进今日', W.stats.dailyCount, 0);
}

console.log('\n[8] 平台提示与本地计数互不干扰');
{
  const el = makeEl('div');
  el.textContent = '今日视频任务点完成数已达上限，您可以观看视频，但无法完成任务点';
  const cur = makeEl('div');
  cur.classList.add('currents');
  cur.textContent = '第1节';
  const done = makeEl('i');
  done.className = 'icon_Completed';
  cur.querySelector = (sel) => (/icon_Completed/.test(String(sel)) ? done : null);

  const { W } = boot({ doc: fakeDoc({ jobCountDivs: [el], catalogNodes: [cur] }) });
  W.tickDaily();
  eq('平台提示命中 → stats.platformLimit=true', W.stats.platformLimit, true);
  eq('平台提示命中时不计数', W.stats.dailyCount, 0);

    // 没有平台提示时：基线 + 完成标记出现 → 正常计数（t28/F2 基线语义）
    const cur2 = makeEl('div');
    cur2.classList.add('currents');
    cur2.textContent = '第1节 视频';
    let done2 = null;
    cur2.querySelector = (sel) => (/icon_Completed/.test(String(sel)) ? done2 : null);
    const { W: W2 } = boot({ doc: fakeDoc({ catalogNodes: [cur2] }) });
    W2.tickDaily();                            // 基线
    eq('无平台提示时基线不计数', W2.stats.dailyCount, 0);
    done2 = makeEl('i'); done2.className = 'icon_Completed';
    W2.tickDaily();
    eq('无平台提示时完成标记出现 → 计数 1', W2.stats.dailyCount, 1);
    eq('platformLimit=false', W2.stats.platformLimit, false);
  }

console.log('\n[9] t28/F3：面板「重置日计数」按钮清空 cxas_daily 并归零面板');
{
  const cur = makeEl('div');
  cur.classList.add('currents');
  cur.textContent = '第1节 视频';
  let done = null;
  cur.querySelector = (sel) => (/icon_Completed/.test(String(sel)) ? done : null);
  const { W, sandbox } = boot({ doc: fakeDoc({ catalogNodes: [cur] }) });
  W.tickDaily();                       // 基线
  done = makeEl('i'); done.className = 'icon_Completed';
  W.tickDaily();
  eq('先计到 1', W.stats.dailyCount, 1);
  eq('cxas_daily 已写入', !!(sandbox.__gm && sandbox.__gm.cxas_daily), true);

  function findByText(el, text) {
    if (!el) return null;
    if (String(el.textContent || '') === text) return el;
    const kids = el.children || [];
    for (let i = 0; i < kids.length; i++) {
      const hit = findByText(kids[i], text);
      if (hit) return hit;
    }
    return null;
  }
  const btn = findByText(W.hud(), '重置日计数');
  eq('面板里存在「重置日计数」按钮', !!btn, true);
  if (btn) {
    btn.onclick();
    eq('点击后 dailyCount 归零', W.stats.dailyCount, 0);
    eq('点击后 cxas_daily 的 count 归零', (sandbox.__gm.cxas_daily || {}).count, 0);
    eq('lastAction 说明已重置', /今日计数已重置/.test(W.stats.lastAction), true);
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);