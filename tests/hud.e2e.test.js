// 真浏览器验证（Edge + CDP）：面板 DOM 指纹每次加载都不同，且页面里没有固定 id/class。
// 运行：node tests/hud.e2e.test.js
//
// 为什么必须用真浏览器：
//   vm 里能断言 `Math.random` 生成的 token 不同，但"元素真的挂进了 DOM、
//   真的没有 #cxas-hud 可查"只有在浏览器里看 document 才算数。
//   验收标准原文就是"两次加载的 id 不一致"，这里直接跑两次真实页面加载。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'xuexitong-assistant.user.js'), 'utf8');
const MOCK_HTML = fs.readFileSync(path.join(__dirname, 'mock', 'hud.html'), 'utf8');
const VIDEO = fs.readFileSync('D:/steam/steamui/movies/controller_generic_thumbstick_move.webm');

const PORT = 18925;
const CDP_PORT = 19224;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/' || u === '/hud.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(MOCK_HTML);
  }
  if (u === '/test.webm') {
    res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': VIDEO.length });
    return res.end(VIDEO);
  }
  res.writeHead(404); res.end('nf');
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
}

/* 面板定位：不能再靠固定 id，只能按"可见文案 + 随机 id"在 DOM 里找。
 * 这也顺带验证了"平台无法用固定选择器找到我们"这件事的另一面：
 * 我们自己也必须靠语义来找，说明固定指纹确实没了。 */
const PANEL = `(function(){
  var a = document.querySelectorAll('div[id]');
  for (var i = 0; i < a.length; i++) {
    if ((a[i].textContent || '').indexOf('学习通助手') >= 0) return a[i];
  }
  return null;
})()`;

const FIXED_FP = `(function(){
  var bad = [];
  var all = document.querySelectorAll('[id],[class]');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (/cxas/i.test(el.id || '')) bad.push('id:' + el.id);
    if (/cxas/i.test(el.className || '')) bad.push('class:' + el.className);
  }
  return bad;
})()`;

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  console.log('[1] mock 服务已启动 http://127.0.0.1:' + PORT);

  const userDataDir = path.join(require('os').tmpdir(), 'cxas-hud-edge-' + Date.now());
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

  // 油猴 API shim：GM 存储走 localStorage（和 jump/answer 测试一致）
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.unsafeWindow = window;
      window.GM_getValue = function (k, d) { try { var v = localStorage.getItem('gm_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
      window.GM_setValue = function (k, v) { try { localStorage.setItem('gm_' + k, JSON.stringify(v)); } catch (e) {} };
      window.GM_xmlhttpRequest = function (o) { if (o && o.onerror) setTimeout(function(){ o.onerror(); }, 0); };
    `,
  });

  // 一次"页面加载"：预置配置 → 打开 mock 页面 → 注入脚本 → 读指纹
  async function loadOnce(cfg) {
    await page.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/hud.html' });
    await sleep(1000);
    await page.eval('localStorage.setItem("gm_cfg", ' + JSON.stringify(JSON.stringify(cfg)) + ')');
    await page.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/hud.html' });
    await sleep(1000);
    await page.eval(SCRIPT);
    await sleep(1400);
    return {
      hudId: await page.eval('(window.__CXAS_DEBUG && window.__CXAS_DEBUG.hud() || {}).id || ""'),
      hudClass: await page.eval('(window.__CXAS_DEBUG && window.__CXAS_DEBUG.hud() || {}).className || ""'),
      btnClass: await page.eval('window.__CXAS_DEBUG ? window.__CXAS_DEBUG.fingerprint.cls.btn : ""'),
      btnCount: await page.eval('(function(){var h=window.__CXAS_DEBUG&&window.__CXAS_DEBUG.hud();if(!h)return 0;var b=h.querySelectorAll("button");return b.length;})()'),
      domId: await page.eval('(' + PANEL + '||{}).id || ""'),
      text: await page.eval('(' + PANEL + '||{textContent:""}).textContent || ""'),
      fixed: await page.eval(FIXED_FP),
      legacyHud: await page.eval('!!document.getElementById("cxas-hud")'),
      legacyBadge: await page.eval('!!document.getElementById("cxas-debug-badge")'),
      btnSameClass: await page.eval(`(function(){
        var h = window.__CXAS_DEBUG && window.__CXAS_DEBUG.hud();
        if (!h) return false;
        var b = h.querySelectorAll('button');
        var cls = window.__CXAS_DEBUG.fingerprint.cls.btn;
        for (var i = 0; i < b.length; i++) { if (b[i].className !== cls) return false; }
        return b.length >= 14;
      })()`),
    };
  }

  console.log('\n[3] 第一次加载：面板已挂进 DOM，且没有固定指纹');
  const L1 = await loadOnce({ verbose: true, debugBadge: false, activeHours: '', humanize: false });
  check('面板已创建', !!L1.hudId && !!L1.domId, L1.hudId);
  check('面板 id 形如随机小写串（长度≥8）', /^[a-z]{8,}$/.test(L1.hudId), L1.hudId);
  check('DOM 里能按 id 找到同一个面板', L1.domId === L1.hudId, 'DOM=' + L1.domId + ' / hook=' + L1.hudId);
  check('面板 class 随机', /^[a-z]{6,}$/.test(L1.hudClass), L1.hudClass);
  check('内部按钮全部使用同一个随机 class', L1.btnSameClass === true,
    'buttons=' + L1.btnCount + ' class=' + L1.btnClass);
  check('document.getElementById("cxas-hud") 查不到', L1.legacyHud === false);
  check('document.getElementById("cxas-debug-badge") 查不到', L1.legacyBadge === false);
  check('整页没有 id/class 含 cxas', L1.fixed.length === 0, L1.fixed.slice(0, 5).join(','));
  check('面板显示拟人化状态', L1.text.indexOf('拟人化：') >= 0,
    (L1.text.split('\n').find((l) => l.indexOf('拟人化：') === 0) || '').trim());
  check('面板显示作息时段', L1.text.indexOf('作息时段：全天') >= 0,
    (L1.text.split('\n').find((l) => l.indexOf('作息时段：') === 0) || '').trim());

  console.log('\n[4] 第二次加载：id/class 必须都不同');
  const L2 = await loadOnce({ verbose: true, debugBadge: false, activeHours: '', humanize: false });
  check('第二次加载面板已创建', !!L2.hudId && /^[a-z]{8,}$/.test(L2.hudId), L2.hudId);
  check('两次加载的面板 id 不同', L1.hudId !== L2.hudId, L1.hudId + ' vs ' + L2.hudId);
  check('两次加载的面板 class 不同', L1.hudClass !== L2.hudClass, L1.hudClass + ' vs ' + L2.hudClass);
  check('两次加载的按钮 class 不同', L1.btnClass !== L2.btnClass, L1.btnClass + ' vs ' + L2.btnClass);
  check('两次的 id 都不是 cxas-hud', L1.hudId !== 'cxas-hud' && L2.hudId !== 'cxas-hud');

  console.log('\n[5] 时段外：真浏览器里确实暂停并给出原因');
  const nowH = new Date().getHours();
  const outRange = ((nowH + 1) % 24) + '-' + ((nowH + 2) % 24);
  // t14/F1 修好后 humanize 是总开关：要测时段闸门必须显式打开 humanize，
  // 并把随机暂停概率压到 0（本场景只关心"时段外停不停"）。
  const L3 = await loadOnce({
    verbose: true, activeHours: outRange, humanize: true, humanizePauseChance: 0,
  });
  check('面板显示"外（已暂停播放）"', /外（已暂停播放）/.test(L3.text),
    (L3.text.split('\n').find((l) => l.indexOf('作息时段：') === 0) || '').trim());
  const lastAction = await page.eval('window.__CXAS_DEBUG ? window.__CXAS_DEBUG.stats.lastAction : ""');
  check('lastAction 说明不在作息时段', /不在作息时段/.test(lastAction), lastAction);

  // ================= 折叠功能 =================
  console.log('\n[折叠] 标题栏折叠/展开');
  const collapsedProbe = `(function(){
    var D = window.__CXAS_DEBUG, h = D && D.hud && D.hud();
    if (!h) return JSON.stringify({ err: 'no hud' });
    var title = null, all = h.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var t = all[i].textContent || '';
      if (t.indexOf('学习通助手') === 0 && all[i].children.length === 0) { title = all[i]; break; }
    }
    return JSON.stringify({
      collapsed: h.__isCollapsed(),
      titleText: title ? title.textContent : '',
      height: Math.round(h.getBoundingClientRect().height)
    });
  })()`;

  await page.eval('window.__CXAS_DEBUG.hud().__applyCollapsed(false)');
  await sleep(120);
  const st1 = JSON.parse(await page.eval(collapsedProbe));
  check('初始为展开态', st1.collapsed === false);
  check('展开时高度较大（>120px）', st1.height > 120, 'height=' + st1.height);
  /* 注意：断言版本号只匹配「形状」（v数字.数字.数字），不写死主版本——
   * 写死 v2 会在下次大版本发布时直接红掉（v4.0.1 就踩过这个坑）。 */
  check('展开时标题含版本号 ▾', /v\d+\.\d+\.\d+\s*▾/.test(st1.titleText), st1.titleText);

  await page.eval('window.__CXAS_DEBUG.hud().__applyCollapsed(true)');
  await sleep(120);
  const st2 = JSON.parse(await page.eval(collapsedProbe));
  check('折叠后状态为 true', st2.collapsed === true);
  check('折叠后高度显著变小（<60px）', st2.height < 60, 'height=' + st2.height);
  check('折叠后标题变状态摘要（含 ▸）', /学习通助手\s*▸/.test(st2.titleText), st2.titleText);
  check('折叠后仍保留「学习通助手」前缀', st2.titleText.indexOf('学习通助手') === 0, st2.titleText);

  const stored = await page.eval("localStorage.getItem('gm_hudCollapsed') || localStorage.getItem('hudCollapsed') || ''");
  check('折叠态写入存储（刷新后保持）', /true/.test(String(stored)), String(stored).slice(0, 30));

  const vh = JSON.parse(await page.eval(`(function(){
    var h = window.__CXAS_DEBUG.hud();
    h.__applyCollapsed(true);
    var kids = Array.prototype.slice.call(h.children);
    var visible = kids.filter(function(k){ return k.style.display !== 'none'; });
    var r = JSON.stringify({ total: kids.length, visible: visible.length });
    h.__applyCollapsed(false);
    return r;
  })()`));
  check('折叠后只剩 1 个可见子元素（标题栏）', vh.visible === 1, '可见/总 = ' + vh.visible + '/' + vh.total);

  await page.eval('window.__CXAS_DEBUG.hud().__applyCollapsed(false)');
  await sleep(120);
  const st3 = JSON.parse(await page.eval(collapsedProbe));
  check('能重新展开', st3.collapsed === false && st3.height > 120, 'height=' + st3.height);
  check('展开后标题恢复版本号', /v\d+\.\d+\.\d+\s*▾/.test(st3.titleText), st3.titleText);

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
