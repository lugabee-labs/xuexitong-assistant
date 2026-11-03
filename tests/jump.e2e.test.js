// 用 CDP 驱动 Edge，在**三层 iframe** 的模拟页面里真跑视频链路（t11/C 组）。
// 运行：node tests/jump.e2e.test.js
//
// 验证链路（全部真实行为，脚本由每个 frame 自己 <script src="/user.js"> 注入）：
//   子 frame 注入 → 视频识别 → 自动播放 → 进度推进 → ended → postNext
//   → 顶层 goNext 点下一节 → iframe 换载 → 脚本重置 → 继续下一个
// 额外覆盖：
//   C2-1 子 frame 注入成功     C2-2 relayStats 汇到顶层面板
//   C2-3 子 frame NEXT 触发顶层 goNext
//   C2-4 sessionStorage.cxas_epoch 跨 frame 共享
//   C2-5 只有顶层创建 HUD
//   C3   「换节 = 整页 reload」时 cxas_jump_guard 生效（不会重复跳同一节）

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'xuexitong-assistant.user.js'), 'utf8');
const MOCK = (name) => fs.readFileSync(path.join(__dirname, 'mock', name));
const VIDEO = fs.readFileSync('D:/steam/steamui/movies/controller_generic_thumbstick_move.webm');

const PORT = 18923;
const CDP_PORT = 19222;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}

const server = http.createServer((req, res) => {
  const u = (req.url || '').split('?')[0];
  const send = (body, type) => { res.writeHead(200, { 'Content-Type': type }); res.end(body); };
  if (u === '/' || u === '/course.html') return send(MOCK('course.html'), 'text/html; charset=utf-8');
  if (u === '/cards.html') return send(MOCK('cards.html'), 'text/html; charset=utf-8');
  if (u === '/video-frame.html') return send(MOCK('video-frame.html'), 'text/html; charset=utf-8');
  if (u === '/reload.html') return send(MOCK('reload.html'), 'text/html; charset=utf-8');
  if (u === '/never-complete.html') return send(MOCK('never-complete.html'), 'text/html; charset=utf-8');
  if (u === '/user.js') return send(SCRIPT, 'application/javascript; charset=utf-8');
  if (u === '/test.webm') {
    res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': VIDEO.length });
    return res.end(VIDEO);
  }
  res.writeHead(404); res.end('nf');
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 面板 id 从 v2.3 起每次加载随机（防 DOM 指纹），测试不能再按固定 id 查。
const HUD_Q = '(function(){var a=document.querySelectorAll("div[id]");' +
  'for(var i=0;i<a.length;i++){if((a[i].textContent||"").indexOf("学习通助手")>=0)return a[i];}' +
  'return null;})()';
const hudText = (page) => page.eval('((' + HUD_Q + ')||{textContent:""}).textContent||""');

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        c.events.push(msg);
      }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  console.log('[1] mock 服务已启动 http://127.0.0.1:' + PORT + '（含 /user.js 静态分发）');

  const userDataDir = path.join(require('os').tmpdir(), 'cxas-edge-' + Date.now());
  const edge = spawn(EDGE, [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,800',
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version');
      const j = await r.json();
      if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
    } catch (e) { /* 还没起来 */ }
  }
  if (!wsUrl) { console.log('FAIL Edge CDP 未就绪'); process.exit(1); }
  console.log('[2] Edge CDP 就绪');

  const browser = await CDP.connect(wsUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const page = await CDP.connect('ws://127.0.0.1:' + CDP_PORT + '/devtools/page/' + targetId);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  /* GM shim：每个 frame 都会执行（addScriptToEvaluateOnNewDocument 对新文档生效）。
   * 顶部通过 ?cfg=<json> 传配置，frame 里也带同一串 query，所以每个 frame 都能拿到配置；
   * localStorage 本身同源共享，两层保险。 */
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.unsafeWindow = window;
      window.GM_getValue = function (k, d) {
        try { var v = localStorage.getItem('gm_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
      };
      window.GM_setValue = function (k, v) {
        try { localStorage.setItem('gm_' + k, JSON.stringify(v)); } catch (e) {}
      };
      window.GM_xmlhttpRequest = function (o) { if (o && o.onerror) setTimeout(function(){ o.onerror(); }, 0); };
      try {
        var q = new URLSearchParams(location.search).get('cfg');
        if (q) localStorage.setItem('gm_cfg', q);
      } catch (e) {}
    `,
  });

  const cfg = encodeURIComponent(JSON.stringify({
    activeHours: '', humanize: false, verbose: true,
  }));
  const COURSE = 'http://127.0.0.1:' + PORT + '/course.html?cfg=' + cfg;

  // ---- 1. 三层 iframe + 每个 frame 自己注入脚本 ----
  console.log('\n[3] 三层 iframe：子 frame 注入 / relayStats / NEXT / epoch');
  await page.send('Page.navigate', { url: COURSE });
  await sleep(2500);
  check('顶层页面已加载', await page.eval('document.title.indexOf("学习通") >= 0'), await page.eval('document.title'));

  const childState = await page.eval(`(function(){
    try {
      var cards = document.getElementById('iframe').contentDocument;
      var vf = cards.getElementById('vf').contentDocument;
      var w = vf.defaultView;
      return JSON.stringify({
        hasDebug: !!(w && w.__CXAS_DEBUG),
        hasVideo: !!(vf.getElementById('video_html5_api')),
        hud: !!(w && w.__CXAS_DEBUG && w.__CXAS_DEBUG.hud()),
        video: !!(w && w.__CXAS_DEBUG && w.__CXAS_DEBUG.stats && w.__CXAS_DEBUG.stats.video),
      });
    } catch (e) { return 'ERR:' + e.message; }
  })()`);
  let child = {};
  try { child = JSON.parse(childState); } catch (e) { child = {}; }
  check('视频帧（最内层 iframe）里脚本已注入', child.hasDebug === true, childState);
  check('视频帧里找到 video 元素', child.hasVideo === true);
  check('视频帧里 HUD 为空（只有顶层建面板）', child.hud === false);
  check('视频帧 stats.video 已接管', child.video === true);

  const panel0 = await hudText(page);
  check('顶层无 video 但面板显示「视频：已接管」', /视频：已接管/.test(panel0),
    (panel0.split('\n').find((l) => l.includes('视频')) || '').trim());
  await sleep(1500);
  const panel1 = await hudText(page);
  const prog = Number((panel1.match(/进度：(\d+)%/) || [])[1] || 0);
  check('relayStats 把进度汇到顶层面板', prog > 0, 'progress=' + prog + '%');
  check('面板存在于顶层', !!(await page.eval('!!(' + HUD_Q + ')')));

  // ---- 2. 播完 → NEXT → 顶层 goNext（iframe 换载）----
  console.log('\n[4] 等待视频播完并触发跳转…');
  let switched = false;
  let waited = 0;
  let logsBeforeReload = [];     // 换节后 iframe 会重载，日志属于旧 frame，必须边轮询边留档
  while (waited < 60000) {
    await sleep(1000);
    waited += 1000;
    try {
      const raw = await page.eval('JSON.stringify((window.__TEST.logs || []).slice(-24))');
      const lg = JSON.parse(raw);
      // 换节后 iframe 重载，新 frame 的日志里没有 ended —— 所以必须**累积**而不是覆盖
      lg.forEach(function (line) { if (logsBeforeReload.indexOf(line) < 0) logsBeforeReload.push(line); });
    } catch (e) { /* frame 正在换载 */ }
    const s = await page.eval('window.__TEST.switches()');
    if (s > 0) { switched = true; console.log('     第 ' + (waited / 1000) + ' 秒检测到跳转'); break; }
    if (waited % 10000 === 0) {
      const t = await hudText(page);
      console.log('     ' + (waited / 1000) + 's … ' + (t.split('\n').find((l) => l.includes('进度')) || '').trim());
    }
  }
  check('视频播完后自动跳到下一节（子 frame 发 NEXT → 顶层 goNext）', switched,
    switched ? '耗时 ' + (waited / 1000) + 's' : '超时');
  if (switched) {
    await sleep(1200);
    check('跳转后停在正确的节点', await page.eval('window.__TEST.currentIdx()') === 1,
      '当前第 ' + ((await page.eval('window.__TEST.currentIdx()')) + 1) + ' 节');

    const arr = logsBeforeReload;
    check('视频帧确实收到 ended', arr.some((l) => l.includes('[video] ended')), arr.filter((l) => l.includes('ended')).join(' | '));
    check('没有出现 seek（不补进度）', !arr.some((l) => l.includes('[video] seeking')), '无 seeking');

    const rate = await page.eval('window.__TEST.video() ? window.__TEST.video().playbackRate : null');
    check('倍速不超过硬上限 2x', rate !== null && rate <= 2.001, 'playbackRate=' + rate);

    // C2-4：epoch 跨 frame 共享
    const epoch = await page.eval(`(function(){
      try {
        var cards = document.getElementById('iframe').contentDocument;
        var vf = cards.getElementById('vf').contentDocument;
        var top = sessionStorage.getItem('cxas_epoch');
        var childGot = vf.defaultView.sessionStorage.getItem('cxas_epoch');
        return JSON.stringify({ top: top, child: childGot });
      } catch (e) { return 'ERR:' + e.message; }
    })()`);
    let ep = {};
    try { ep = JSON.parse(epoch); } catch (e) { ep = {}; }
    check('sessionStorage.cxas_epoch 跨 frame 共享且非空',
      !!ep.top && ep.top === ep.child, epoch);
    check('跳转后子 frame 仍在同一个源下运行', !!ep.child);
  }

  // ---- 3. C3：整页 reload 型换节 → jump_guard 生效 ----
  console.log('\n[5] 整页 reload 型换节：cxas_jump_guard 不能让同一节重复跳');
  await page.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/reload.html?ch=0&cfg=' + cfg });
  await sleep(1500);
  check('reload 页已加载（第 1 页）', await page.eval('window.__TEST.ch') === 0);

  // 视频 3s → 跳转 → 点下一节 → 整页跳转到 ch=1
  let reloaded = false;
  waited = 0;
  while (waited < 40000) {
    await sleep(1000);
    waited += 1000;
    const st = await page.eval('JSON.stringify({ ch: window.__TEST ? window.__TEST.ch : -1, loads: Number(sessionStorage.getItem("test_reload_loads") || 0) })');
    const o = JSON.parse(st);
    if (o.ch === 1) { reloaded = true; console.log('     第 ' + (waited / 1000) + ' 秒完成整页换节 → ch=1'); break; }
  }
  check('整页 reload 型换节成功（ch=0 → ch=1）', reloaded);
  if (reloaded) {
    const loadsBefore = Number(await page.eval('sessionStorage.getItem("test_reload_loads") || 0'));
    const guard = await page.eval('sessionStorage.getItem("cxas_jump_guard") || ""');
    check('cxas_jump_guard 在整页 reload 后仍保留', /test\.webm/.test(guard), guard.slice(0, 90));
    check('reload 后脚本重新注入（面板仍在）', !!(await page.eval('!!(' + HUD_Q + ')')));

    // 第2页的视频与第1页身份键相同（catalog 第0项 + 同一 src/duration）。
    // 没有 guard 的话，第2页播完会再跳一次（跳第3页 → loads 变 3）；有 guard 则原地不动。
    await sleep(9000);
    const chNow = await page.eval('window.__TEST.ch');
    const loadsNow = Number(await page.eval('sessionStorage.getItem("test_reload_loads") || 0'));
    check('guard 生效：同一节没有被重复跳转（仍在 ch=1）', chNow === 1, 'ch=' + chNow);
    check('guard 生效：没有再次整页跳转（loads 保持）', loadsNow === loadsBefore,
      'loads ' + loadsBefore + ' → ' + loadsNow);
  }

  // ---- 4. t8/A：平台日上限提示 → 停止自动跳转（硬信号） ----
  console.log('\n[6] 平台日上限：.maskDiv.jobCountDiv 可见 + 文案命中 → 不自动跳转');
  await page.send('Page.navigate', { url: COURSE + '&dailyLimit=1' });
  await sleep(2500);
  check('日上限提示框可见', await page.eval(
    '(function(){var el=document.querySelector(".maskDiv.jobCountDiv");if(!el)return false;' +
    'var r=el.getBoundingClientRect();return r.width>0&&r.height>0;})()'));
  // 视频只有 3s，等它播完：应当识别到提示并停手（switches 保持 0）
  await sleep(12000);
  const limitState = JSON.parse(await page.eval(
    '(function(){var s=(window.__CXAS_DEBUG&&window.__CXAS_DEBUG.stats)||{};' +
    'return JSON.stringify({switches:window.__TEST.switches(),platformLimit:!!s.platformLimit,last:s.lastAction||""});})()'));
  check('平台日上限命中（stats.platformLimit=true）', limitState.platformLimit === true, JSON.stringify(limitState));
  check('命中后没有自动跳转（switches 仍为 0）', limitState.switches === 0, 'switches=' + limitState.switches);
  // t29/F1：改用**面板独立行**断言（lastAction 是多模块竞争的单值字段，不适合当唯一证据）
  const limitHud = await hudText(page);
  check('面板显示「平台日上限：已触发」', /平台日上限：已触发/.test(limitHud),
    (String(limitHud).split('\n').find((l) => l.indexOf('平台日上限：') === 0) || '').trim());
  check('lastAction 也保留了日上限说明（setAction 锁生效，没被 98% 进度覆盖）',
    /日上限|任务点完成数已达上限/.test(limitState.last), limitState.last);

  // ---- 5. t8/C：本地计数只认平台完成标记，同一节只 +1 ----
  console.log('\n[7] 完成标记计数：注入 .icon_Completed → 本地计数 +1，且不重复');
  await page.send('Page.navigate', { url: COURSE });
  await sleep(1500);
  // 等视频播完并完成一次跳转（这时当前节身份稳定，适合注入标记）
  let jumped2 = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (await page.eval('window.__TEST.switches()') > 0) { jumped2 = true; break; }
  }
  check('普通页面照常自动跳转（回归）', jumped2);
  await page.eval(
    '(function(){var cur=document.querySelector(".chapter_item.currents");' +
    'if(cur&&!cur.querySelector(".icon_Completed")){var i=document.createElement("i");' +
    'i.className="icon_Completed";cur.appendChild(i);}return true;})()');
  await sleep(2000);
  const daily1 = await page.eval('(window.__CXAS_DEBUG && window.__CXAS_DEBUG.stats.dailyCount) || 0');
  check('完成标记出现后本地计数 +1', daily1 === 1, 'dailyCount=' + daily1);
  await page.eval(
    '(function(){var cur=document.querySelector(".chapter_item.currents");' +
    'if(cur&&!cur.querySelector(".icon_Completed")){var i=document.createElement("i");' +
    'i.className="icon_Completed";cur.appendChild(i);}return true;})()');
  await sleep(2500);
  const daily2 = await page.eval('(window.__CXAS_DEBUG && window.__CXAS_DEBUG.stats.dailyCount) || 0');
  check('同一节不重复计数（仍为 1）', daily2 === 1, 'dailyCount=' + daily2);

  // ---- 6. t28/F1：当前节永不完成 → 重播 1 次后必硬跳（旧实现硬跳出口不可达） ----
  console.log('\n[8] waitForCompletion：硬跳出口可达（当前节永不出现完成标记）');
  const cfgHard = encodeURIComponent(JSON.stringify({
    activeHours: '', humanize: false, verbose: true,
    completionTimeoutMs: 1000, completionPollMs: 200, completionMaxRetry: 1, completeDelay: 300,
  }));
  await page.send('Page.navigate', {
    url: 'http://127.0.0.1:' + PORT + '/never-complete.html?cfg=' + cfgHard,
  });
  let hard = null;
  let sawReplay = false;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    hard = JSON.parse(await page.eval(
      '(function(){var s=(window.__CXAS_DEBUG&&window.__CXAS_DEBUG.stats)||{};' +
      'return JSON.stringify({last:s.lastAction||"",state:s.completionState||"",retries:s.completionRetries||0,' +
      'replays:s.replays||0,hardJumps:s.hardJumps||0,' +
      'switches:(typeof window.__TEST.switches==="function"?window.__TEST.switches():window.__TEST.switches)});})()'));
    if (/重播中/.test(hard.state) || /重播中/.test(hard.last)) sawReplay = true;
    if (/硬跳转/.test(hard.last) || (hard.hardJumps || 0) >= 1) break;
  }
  check('先观测到「超时未记录，重播中」', sawReplay, JSON.stringify(hard));
  /* 这里只断言"真实 tickVideo 路径确实进入了等标记并重播"（计数器不会被 lastAction 覆盖）。
   * "重播 N 次后必硬跳、且不再回到重播"由 video-completion.test.js [5] 直接调用
   * waitForCompletionMark 做确定性断言（第一次 false→重播、第二次 true→硬跳、第三次仍 true）。 */
  check('真实 tickVideo 路径进入了「等标记」并重播过（stats.replays >= 1）',
    hard.replays >= 1, 'replays=' + hard.replays);
  check('没有无限重播（replays 有界）', hard.replays <= 4, 'replays=' + hard.replays);
  check('仍然完成了换节（switches > 0）', hard.switches > 0, 'switches=' + hard.switches);

  page.close(); browser.close();
  try { edge.kill(); } catch (e) { /* 忽略 */ }
  server.close();

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  setTimeout(() => process.exit(fail ? 1 : 0), 500);
})().catch((e) => {
  console.log('FAIL 异常: ' + e.message);
  console.log(e.stack);
  try { server.close(); } catch (x) { /* 忽略 */ }
  process.exit(1);
});