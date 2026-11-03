// 真浏览器测试：弹题 + 章节测验（零 input 真实结构）能否正常作答与提交（t11/A1/A2/A3）
// 运行：node tests/answer.e2e.test.js
//
// 本文件的两条验收主线：
//   1) work.html 是**零 input** 的真实结构（li.before-after + hidden answer{qid}），
//      脚本仍能答对并提交 —— 这是 t11 修复成立与否的唯一标准；
//   2) 确认层在**顶层文档** `.popDiv.Marking`，只点「提交」不点「取消」；
//      提交后**不整页跳转**（真实行为），断言改为"仍在原页 + 出现成绩文本"。
//
// 脚本由 mock 页面自己 <script src="/user.js"> 注入（每个 frame 各自一份），
// 配置通过 ?cfg=<json> 传给 shim —— 与真实油猴"每个 frame 都注入"一致。

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'xuexitong-assistant.user.js'), 'utf8');
const MOCK = (name) => fs.readFileSync(path.join(__dirname, 'mock', name));
const VIDEO = fs.readFileSync('D:/steam/steamui/movies/controller_generic_thumbstick_move.webm');

const PORT = 18924;
const CDP_PORT = 19223;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mock AI：按题目关键词返回不同答案，验证解析与映射 ----
const aiCalls = [];
function answerFor(prompt) {
  if (/可靠的传输层协议/.test(prompt)) return 'B';      // 弹题 → TCP
  if (/HTTP 协议默认使用的端口号/.test(prompt)) return 'B'; // 单选 → 80
  if (/面向对象的特征/.test(prompt)) return 'ABC';        // 多选
  if (/无状态/.test(prompt)) return '对';                 // 判断题
  if (/传输层协议名是/.test(prompt)) return 'TCP|80';      // 填空题：两个空用 | 分隔
  if (/三次握手/.test(prompt)) return '客户端发 SYN，服务端回 SYN+ACK，客户端再回 ACK。'; // 简答题（默认不作答）
  if (/计算机网络的描述/.test(prompt)) return 'A';            // Q6：题干含题型干扰词，必须照常作答
  if (/应用层协议/.test(prompt)) return 'A';                    // 分页考试第3页
  if (/传输层协议/.test(prompt)) return 'A';                    // 分页考试第1题
  if (/面向连接的协议/.test(prompt)) return '对';               // 分页考试第2题
  return 'A';
}

const server = http.createServer((req, res) => {
  const u = (req.url || '').split('?')[0];
  const send = (body, type) => { res.writeHead(200, { 'Content-Type': type }); res.end(body); };

  if (u === '/' || u === '/course.html') return send(MOCK('course.html'), 'text/html; charset=utf-8');
  if (u === '/cards.html') return send(MOCK('cards.html'), 'text/html; charset=utf-8');
  if (u === '/video-frame.html') return send(MOCK('video-frame.html'), 'text/html; charset=utf-8');
  if (u === '/work.html') return send(MOCK('work.html'), 'text/html; charset=utf-8');
  if (u === '/work-frame.html') return send(MOCK('work-frame.html'), 'text/html; charset=utf-8');
  if (u === '/work-paged.html') return send(MOCK('work-paged.html'), 'text/html; charset=utf-8');
  if (u === '/user.js') return send(SCRIPT, 'application/javascript; charset=utf-8');
  if (u === '/test.webm') {
    res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': VIDEO.length });
    return res.end(VIDEO);
  }

  // mock OpenAI 兼容端点
  if (u === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch (e) { /* 忽略 */ }
      const userMsg = (payload.messages || []).filter(m => m.role === 'user').map(m => m.content).join('\n');
      aiCalls.push({ model: payload.model, prompt: userMsg, headers: req.headers });
      const ans = answerFor(userMsg);
      const resp = {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: payload.model || 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: ans }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 50, completion_tokens: 3, total_tokens: 53 },
      };
      send(JSON.stringify(resp), 'application/json');
    });
    return;
  }

  res.writeHead(404); res.end('nf');
});

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
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
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const BASE = 'http://127.0.0.1:' + PORT;
  console.log('[1] mock 服务已启动 ' + BASE + '（含 mock AI 端点 /v1/chat/completions）');

  const userDataDir = path.join(os.tmpdir(), 'cxas-edge-ans-' + Date.now());
  const edge = spawn(EDGE, [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDataDir,
    '--no-first-run', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version');
      const j = await r.json();
      if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
    } catch (e) { /* 等 */ }
  }
  if (!wsUrl) { console.log('FAIL Edge CDP 未就绪'); process.exit(1); }
  console.log('[2] Edge CDP 就绪');

  const browser = await CDP.connect(wsUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const page = await CDP.connect('ws://127.0.0.1:' + CDP_PORT + '/devtools/page/' + targetId);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  /* GM shim：每个 frame 都会在执行页面脚本前拿到配置（?cfg=<json>），
   * GM_xmlhttpRequest 走真实 fetch（这样 mock AI 端点能被真正调用）。 */
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.unsafeWindow = window;
      window.GM_getValue = function (k, d) {
        try { var v = localStorage.getItem('gm_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
      };
      window.GM_setValue = function (k, v) {
        try { localStorage.setItem('gm_' + k, JSON.stringify(v)); } catch (e) {}
      };
      window.GM_xmlhttpRequest = function (o) {
        var opt = { method: o.method || 'GET', headers: o.headers || {} };
        if (o.data) opt.body = o.data;
        fetch(o.url, opt).then(function (r) {
          return r.text().then(function (t) { return { status: r.status, responseText: t }; });
        }).then(function (res) { if (o.onload) o.onload(res); })
          .catch(function (e) { if (o.onerror) o.onerror(e); });
      };
      try {
        var q = new URLSearchParams(location.search).get('cfg');
        if (q) localStorage.setItem('gm_cfg', q);
      } catch (e) {}
    `,
  });

  const cfgObj = {
    aiBaseUrl: BASE + '/v1',
    aiModel: 'mock-model',
    aiApiKey: 'test-key',
    aiEnabled: true,
    aiProvider: 'custom',
    aiTimeout: 5000,
    verbose: true,
    activeHours: '',
    humanize: false,
  };
  const cfg = encodeURIComponent(JSON.stringify(cfgObj));

  // ================= 场景 A：视频弹题（真实 #videoquiz-submit + .tkTopic） =================
  console.log('\n[3] 场景A：视频内弹题自动作答（三层 iframe，弹题在视频帧）');
  aiCalls.length = 0;
  await page.send('Page.navigate', { url: BASE + '/course.html?quiz=1&cfg=' + cfg });
  await sleep(4000);

  const picked = JSON.parse(await page.eval('JSON.stringify(window.__TEST.picked())'));
  check('弹题被检测到并作答', picked.length > 0, '选中=' + JSON.stringify(await page.eval('JSON.stringify(window.__TEST.pickedText())')));
  check('选中正确答案（B. TCP，索引1）', JSON.stringify(picked) === '[1]', '实际 ' + JSON.stringify(picked));
  check('AI 端点被真实调用', aiCalls.length > 0, '调用 ' + aiCalls.length + ' 次');
  check('AI 收到的题面包含题干（.tkTopic 取到了题面）',
    aiCalls.some(c => /可靠的传输层协议/.test(c.prompt)),
    aiCalls.length ? aiCalls[0].prompt.replace(/\n/g, ' | ').slice(0, 60) : '无');
  check('弹题选项是点 input（没有点 li）', await page.eval('window.__TEST.liClicks()') === 0,
    'li 点击次数=' + await page.eval('window.__TEST.liClicks()'));

  await sleep(2000);
  check('弹题已自动提交（a#videoquiz-submit）', await page.eval('window.__TEST.quizSubmitted()'),
    '提交内容=' + JSON.stringify(await page.eval('JSON.stringify(window.__TEST.submitPayload())')));
  check('提交后点了「继续学习」恢复播放（a#videoquiz-continue）',
    await page.eval('window.__TEST.continueClicked()'));

  // ================= 场景 B：章节测验（零 input + 顶层确认层） =================
  console.log('\n[4] 场景B：章节测验（零 input 真实结构）自动作答 + 提交 + 成绩文本');
  const callsBefore = aiCalls.length;
  await page.send('Page.navigate', { url: BASE + '/work-frame.html?cfg=' + cfg });
  await sleep(1500);

  const inner = `document.getElementById('frame_content').contentWindow.__TEST`;
  check('章节测验题目在 iframe#frame_content 内层',
    await page.eval('!!' + inner), 'inner __TEST 可用');
  check('顶层脚本能通过 allDocs() 找到内层题目（findWorkDoc）',
    await page.eval(`(function(){
      try {
        var d = window.__CXAS_DEBUG && window.__CXAS_DEBUG.findWorkDoc();
        return JSON.stringify({ crossDoc: d ? d !== document : false, hasTiMu: !!(d && d.querySelector('.TiMu')) });
      } catch (e) { return 'ERR:' + e.message; }
    })()`) === '{"crossDoc":true,"hasTiMu":true}',
    await page.eval(`(function(){
      try { var d = window.__CXAS_DEBUG.findWorkDoc(); return d === document ? 'same-doc' : (d ? 'child-doc' : 'null'); }
      catch (e) { return 'ERR'; }
    })()`));
  check('mock 是零 input 结构（页面里 radio/checkbox 数 = 0）',
    await page.eval(inner + '.inputCount()') === 0,
    'input 数=' + await page.eval(inner + '.inputCount()'));
  // t20/F2：读**脚本侧**的解析结果，而不是 mock 的 qCount()（后者在解析回归时仍会绿）
  const scriptParsed = await page.eval(`(function(){
    try {
      var d = window.__CXAS_DEBUG && window.__CXAS_DEBUG.findWorkDoc();
      return d ? window.__CXAS_DEBUG.parseWorkQuestions(d).length : -1;
    } catch (e) { return -1; }
  })()`);
  check('脚本侧解析到 6 道题（读 __CXAS_DEBUG.parseWorkQuestions，不是 mock 计数）',
    scriptParsed === 6, 'script parsed=' + scriptParsed);

  // 逐题作答 + 提交需要时间（每题间隔 1.2–3.2s + 提交探测）
  let answered = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    answered = await page.eval(inner + '.answeredCount()');
    if (answered >= 5) break;
  }
  check('5 道题被作答（4 客观含干扰题干题 + 1 填空；简答按策略不作答）', answered === 5, '已答 ' + answered + '/5');

  const dump = JSON.parse(await page.eval('JSON.stringify(' + inner + '.dump())'));
  console.log('     作答明细：');
  dump.forEach((d) => console.log('       第' + d.block + '题 ' + d.title + '  →  ' +
    JSON.stringify(d.picked) + (d.blanks && d.blanks.length ? '  填空=' + JSON.stringify(d.blanks) : '')));

  check('单选选对（HTTP端口 → B.80）',
    dump[0] && dump[0].picked.length === 1 && dump[0].picked[0].startsWith('B:'),
    JSON.stringify(dump[0] && dump[0].picked));
  check('多选选对（面向对象 → A/B/C）',
    dump[1] && dump[1].picked.length === 3 && dump[1].picked.every(p => /^[ABC]:/.test(p)),
    JSON.stringify(dump[1] && dump[1].picked));
  check('判断题选对（无状态协议 → 对）',
    dump[2] && dump[2].picked.length === 1 && /^true:对/.test(dump[2].picked[0]),
    JSON.stringify(dump[2] && dump[2].picked));
  // t4：填空按 | 分段落进两个 textarea；简答按默认策略**不作答**
  check('填空题两个空都填对（TCP / 80）',
    dump[3] && JSON.stringify(dump[3].blanks) === JSON.stringify(['TCP', '80']),
    JSON.stringify(dump[3] && dump[3].blanks));
  check('简答题按策略未作答（textarea 仍为空）',
    dump[4] && dump[4].blanks.length === 1 && dump[4].blanks[0] === '',
    JSON.stringify(dump[4] && dump[4].blanks));
  // t22/F1 回归：题干含"计算机网络"（题型词干扰）+ 无 .newZy_TItle → 必须照常作答
  check('题干含「计算机网络」的题被正常作答（未误判成计算/主观）',
    dump[5] && dump[5].picked.length === 1 && /^A:/.test(dump[5].picked[0]),
    JSON.stringify(dump[5] && dump[5].picked) + ' / ' + (dump[5] && dump[5].title));
  check('AI 被调用（测验题）', aiCalls.length > callsBefore, '新增 ' + (aiCalls.length - callsBefore) + ' 次');

  await page.eval('localStorage.removeItem("test_submit_clicked"); localStorage.removeItem("test_confirm_clicked"); localStorage.removeItem("test_cancel_clicked")');
  let submitted = false, confirmed = false, cancelled = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    submitted = (await page.eval('localStorage.getItem("test_submit_clicked")')) === '1';
    confirmed = (await page.eval('localStorage.getItem("test_confirm_clicked")')) === '1';
    cancelled = (await page.eval('localStorage.getItem("test_cancel_clicked")')) === '1';
    if (submitted && confirmed) break;
  }
  check('章节测验已自动点提交（a.btnSubmit）', submitted);
  check('顶层确认层 .popDiv.Marking 的「提交」被点掉', confirmed);
  check('没有误点「取消」', cancelled === false);
  check('确认层已消失', await page.eval('!window.__TEST.markingVisible()'));

  // C4：真实环境提交后**不整页跳转**（内层 iframe 自己刷新成批阅页）
  await sleep(3000);
  const url = await page.eval('location.pathname');
  check('提交后仍在原页（不整页跳转）', url === '/work-frame.html', '当前 ' + url);
  check('页面出现成绩文本（已完成/本次成绩）',
    /已完成|本次成绩/.test(await page.eval(inner + '.resultText()')),
    (await page.eval(inner + '.resultText()')).trim());

  // t4：面板显示题型分布（本题库：单选1 多选1 判断1 填空1 简答1）
  const panelText = await page.eval(`(function(){
    var a = document.querySelectorAll('div[id]');
    for (var i = 0; i < a.length; i++) {
      if ((a[i].textContent || '').indexOf('学习通助手') >= 0) return a[i].textContent;
    }
    return '';
  })()`);
  check('面板显示题型分布（含 单选题2 / 简答题1）',
    /题型：/.test(panelText) && /单选题2/.test(panelText) && /简答题1/.test(panelText),
    (String(panelText).split('\n').find((l) => l.indexOf('题型：') === 0) || '').trim());
  // t24/F2'：把「策略跳过 N」固化成断言 —— 面板行改字或 WORK_STATS 中继丢失都会立刻报警
  check('面板显示「测验已作答：N 题（策略跳过 M）」（简答被策略跳过 1 题）',
    /测验已作答：5 题（策略跳过 1）/.test(panelText),
    (String(panelText).split('\n').find((l) => l.indexOf('测验已作答：') === 0) || '').trim());

  // ================= 场景C：t6 两遍法——采集阶段零点击（核心断言） =================
  console.log('\n[4c] 两遍法：先全量采集，再统一作答');
  const collectState = JSON.parse(await page.eval(`(function(){
    var s = window.__CXAS_DEBUG.stats;
    var t = window.__TEST.inner && window.__TEST.inner();
    return JSON.stringify({
      collected: s.collected, collectedAt: s.collectedAt, mode: s.mode,
      firstClickAt: (t && t.firstClickAt) || 0, clicks: (t && t.optionClicks) || 0
    });
  })()`));
  check('采集到 6 题（two-pass 模式）',
    collectState.collected === 6 && collectState.mode === 'two-pass',
    JSON.stringify(collectState));
  check('采集阶段零点击：首次点选项发生在「采集完成」之后',
    collectState.clicks > 0 && collectState.firstClickAt >= collectState.collectedAt - 50,
    'firstClickAt=' + collectState.firstClickAt + ' collectedAt=' + collectState.collectedAt);
  check('面板显示「已采集 6 题」', /采集：已采集 6 题/.test(panelText),
    (String(panelText).split('\n').find((l) => l.indexOf('采集：') === 0) || '').trim());
  check('面板显示「作答进度：M / N 题」', /作答进度：5 \/ 6 题/.test(panelText),
    (String(panelText).split('\n').find((l) => l.indexOf('作答进度：') === 0) || '').trim());

  // ================= 场景B2：t20/F1 真实「下一节」按钮 + 防双跳 =================
  console.log('\n[4b] 批阅页：优先点 #prevNextFocusNext，且不双跳');
  let nextClicks = 0;
  for (let i = 0; i < 12; i++) {
    await sleep(700);
    nextClicks = await page.eval('window.__TEST.nextClicks');
    if (nextClicks > 0) break;
  }
  check('优先点真实「下一节」按钮（#prevNextFocusNext）', nextClicks === 1, 'nextClicks=' + nextClicks);
  check('没有落到「返回课程」文案兜底',
    await page.eval('(function(){var t=window.__TEST.inner();return !!(t && t.backClicked);})()') === false);
  check('没有双跳（目录节点未被 postNext 触发）',
    await page.eval('window.__TEST.switches') === 0,
    'switches=' + await page.eval('window.__TEST.switches'));

  // 防重：再调一次 backToCourse 不应再点
  await page.eval('window.__CXAS_DEBUG.backToCourse()');
  check('重复调用 backToCourse 不会重复点「下一节」',
    await page.eval('window.__TEST.nextClicks') === 1,
    'nextClicks=' + await page.eval('window.__TEST.nextClicks'));

  // 已发过 NEXT 就不要再点「下一节」（否则和目录跳转双跳）
  await page.eval('window.__CXAS_DEBUG.postNext()');
  const beforePostNext = await page.eval('window.__TEST.nextClicks');
  await page.eval('window.__CXAS_DEBUG.backToCourse()');
  check('已发过 NEXT 时不再点「下一节」（防双跳）',
    await page.eval('window.__TEST.nextClicks') === beforePostNext,
    beforePostNext + ' → ' + await page.eval('window.__TEST.nextClicks'));

  // ================= 场景D：t6 分页考试兜底（不允许整卷预览） =================
  console.log('\n[4d] 分页考试（3 页）：翻到底并正常退出（断言等"终止原因"出现再判）');
  await page.send('Page.navigate', { url: BASE + '/work-paged.html?cfg=' + cfg });
  const readPaged = async () => JSON.parse(await page.eval(`(function(){
    var t = window.__TEST || {};
    var s = (window.__CXAS_DEBUG && window.__CXAS_DEBUG.stats) || {};
    return JSON.stringify({
      views: t.pageViews || 0, next: t.nextClicks || 0, submitted: !!t.submitClicked,
      state: t.state ? t.state() : {}, mode: s.mode || '', last: s.lastAction || ''
    });
  })()`));
  let paged = null;
  // t26/L4：不按固定条件退出，而是等 lastAction 出现**终止原因**（不再依赖时序假设）
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    paged = await readPaged();
    if (paged.views >= 3 && /没有「下一题」|退出防死循环|达到最大页数/.test(paged.last)) break;
  }
  check('分页考试翻到第 3 页（默认 3 页）', paged.views === 3, 'pageViews=' + paged.views);
  check('点了 2 次「下一题」', paged.next === 2, 'nextClicks=' + paged.next);
  check('第 1 页作答正确（TCP → A）', paged.state.p1 === 'A', 'p1=' + paged.state.p1);
  check('第 2 页作答正确（面向连接 → true）', paged.state.p2 === 'true', 'p2=' + paged.state.p2);
  check('第 3 页作答正确（HTTP → A）', paged.state.p3 === 'A', 'p3=' + paged.state.p3);
  check('分页模式标记（mode=paged）', paged.mode === 'paged', 'mode=' + paged.mode);
  check('终止原因写明「没有「下一题」」', /没有「下一题」/.test(paged.last), paged.last);
  check('考试默认不自动交卷（提交按钮未被点）', paged.submitted === false);

  console.log('\n[4e] 分页页数上限：无限翻页 → 到上限即停（examMaxPages=2）');
  const cfgCap = encodeURIComponent(JSON.stringify(Object.assign({}, cfgObj, { examMaxPages: 2 })));
  await page.send('Page.navigate', { url: BASE + '/work-paged.html?loop=1&cfg=' + cfgCap });
  let capped = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    capped = await readPaged();
    if (/达到最大页数/.test(capped.last)) break;
  }
  check('无限翻页在页数上限处停止（lastAction 含「最大页数 2」）', /达到最大页数 2/.test(capped.last), capped.last);
  check('只渲染了 2 页（没有无限翻页）', capped.views === 2, 'pageViews=' + capped.views);

  // ================= 汇总 =================
  console.log('\n[5] AI 调用汇总：');
  aiCalls.forEach((c, i) => {
    console.log('     #' + (i + 1) + ' model=' + c.model + '  题面=' + c.prompt.replace(/\n/g, ' / ').slice(0, 55));
  });

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
