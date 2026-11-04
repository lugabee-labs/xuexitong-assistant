// 本机可视化验证：真浏览器加载 mock 页面，注入脚本，截图面板（展开 + 折叠）
// 运行：node tools/screenshot-hud.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'xuexitong-assistant.user.js'), 'utf8');
const COURSE = fs.readFileSync(path.join(ROOT, 'tests', 'mock', 'course.html'), 'utf8');
const VIDEO = fs.readFileSync('D:/steam/steamui/movies/controller_generic_thumbstick_move.webm');

const PORT = 18930;
const CDP = 19230;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(ROOT, 'tests', '_shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/' || u === '/course.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(COURSE);
  }
  if (u === '/test.webm') {
    res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': VIDEO.length });
    return res.end(VIDEO);
  }
  res.writeHead(404); res.end('nf');
});

class C {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); }
  static async conn(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new C(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.p.has(m.id)) {
        const { resolve, reject } = c.p.get(m.id);
        c.p.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.p.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); reject(new Error('timeout ' + method)); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const ed = r.exceptionDetails;
      const desc = (ed.exception && (ed.exception.description || ed.exception.value)) || ed.text || 'unknown';
      throw new Error('Runtime.evaluate 异常: ' + String(desc).split('\n').slice(0, 6).join(' | '));
    }
    return r.result.value;
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(PORT, r));

  const ud = path.join(os.tmpdir(), 'cxas-shot-' + Date.now());
  const edge = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + CDP, '--user-data-dir=' + ud,
    '--no-first-run', '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,860', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      const r = await fetch('http://127.0.0.1:' + CDP + '/json/version');
      const j = await r.json();
      if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
    } catch (e) { /* 等 */ }
  }
  if (!wsUrl) { console.log('FAIL Edge CDP 未就绪'); process.exit(1); }

  const browser = await C.conn(wsUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const page = await C.conn('ws://127.0.0.1:' + CDP + '/devtools/page/' + targetId);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 860, deviceScaleFactor: 1, mobile: false,
  });

  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.unsafeWindow = window;
      window.GM_getValue = function(k,d){
        // 调试钩子只在 verbose/debugBadge 开启时暴露；截图要拿 hud() 所以预置 verbose
        if (k === 'cfg') return { verbose: true };
        try{var v=localStorage.getItem('gm_'+k); return v===null?d:JSON.parse(v);}catch(e){return d;}
      };
      window.GM_setValue = function(k,v){ try{localStorage.setItem('gm_'+k,JSON.stringify(v));}catch(e){} };
      window.GM_xmlhttpRequest = function(o){ if(o&&o.onerror) setTimeout(function(){o.onerror();},0); };
    `,
  });

  await page.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/course.html' });
  await sleep(1200);
  await page.eval(SCRIPT);
  await sleep(2500);   // 让面板建起来、视频开始播

  const shot = async (name) => {
    const r = await page.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('  已保存 ' + p);
    return p;
  };

  // 展开态
  await page.eval('window.__CXAS_DEBUG.hud().__applyCollapsed(false)');
  await sleep(400);
  console.log('[1] 面板展开态：');
  await shot('hud-expanded.png');

  // 折叠态
  await page.eval('window.__CXAS_DEBUG.hud().__applyCollapsed(true)');
  await sleep(400);
  console.log('[2] 面板折叠态：');
  await shot('hud-collapsed.png');

  // 打印面板文本，确认内容
  const txt = await page.eval(`(function(){
    var h = window.__CXAS_DEBUG.hud();
    h.__applyCollapsed(false);
    return h.innerText || h.textContent || '';
  })()`);
  console.log('\n[3] 面板实际内容：');
  String(txt).split('\n').filter(Boolean).forEach((l) => console.log('    ' + l.trim()));

  const ver = await page.eval('window.__CXAS_DEBUG.version');
  const stats = await page.eval('JSON.stringify({video:__CXAS_DEBUG.stats.video,progress:__CXAS_DEBUG.stats.progress,quiz:__CXAS_DEBUG.stats.quiz})');
  console.log('\n[4] 运行时状态：');
  console.log('    version = ' + ver);
  console.log('    stats   = ' + stats);

  page.ws.close(); browser.ws.close();
  try { edge.kill(); } catch (e) { /* 忽略 */ }
  server.close();
  console.log('\n完成，截图在 ' + OUT);
  setTimeout(() => process.exit(0), 500);
})().catch((e) => {
  console.log('FAIL: ' + e.message);
  console.log(e.stack);
  try { server.close(); } catch (x) { /* 忽略 */ }
  process.exit(1);
});
