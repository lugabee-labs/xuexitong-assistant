// TTF cmap 解析器测试：从 user.js 中抽取真实实现，用系统字体验证。
// 运行：node tests/cmap.test.js

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'xuexitong-assistant.user.js'), 'utf8');

// 从脚本里抽取 parseCmap / readFormat4 / readFormat12 / readFormat6 的真实源码
function extractFn(name) {
  const re = new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{', 'm');
  const m = re.exec(SRC);
  if (!m) throw new Error('未找到函数 ' + name);
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < SRC.length && depth > 0) {
    const ch = SRC[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return SRC.slice(m.index, i);
}

const code = [
  extractFn('parseCmap'),
  extractFn('readFormat4'),
  extractFn('readFormat12'),
  extractFn('readFormat6'),
  'return { parseCmap };',
].join('\n\n');

const parseCmap = new Function(code)().parseCmap;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

// ---- arial.ttf：应覆盖 ASCII ----
const arialPath = 'C:/Windows/Fonts/arial.ttf';
if (fs.existsSync(arialPath)) {
  const buf = fs.readFileSync(arialPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const codes = parseCmap(ab);
  console.log('\n[arial.ttf] 解析出 ' + codes.length + ' 个码位');
  check('返回非空', codes.length > 100, 'got ' + codes.length);
  check('包含 A (0x41)', codes.includes(0x41));
  check('包含 a (0x61)', codes.includes(0x61));
  check('包含 0 (0x30)', codes.includes(0x30));
  check('包含空格 (0x20)', codes.includes(0x20));
  const asciiCount = codes.filter((c) => c >= 0x20 && c <= 0x7e).length;
  check('ASCII 可打印区覆盖 ≥90', asciiCount >= 90, 'got ' + asciiCount);
} else {
  console.log('\n[skip] 未找到 arial.ttf');
}

// ---- 边界情况：空/垃圾数据不应抛异常 ----
console.log('\n[边界]');
try {
  const empty = parseCmap(new ArrayBuffer(0));
  check('空 buffer 返回 []', Array.isArray(empty) && empty.length === 0);
} catch (e) { check('空 buffer 不抛异常', false, e.message); }

try {
  const junk = new ArrayBuffer(64);
  new Uint8Array(junk).fill(0xAB);
  const r = parseCmap(junk);
  check('垃圾数据不抛异常', Array.isArray(r));
} catch (e) { check('垃圾数据不抛异常', false, e.message); }

try {
  const tiny = new ArrayBuffer(8);
  const r = parseCmap(tiny);
  check('过短 buffer 返回 []', Array.isArray(r) && r.length === 0);
} catch (e) { check('过短 buffer 不抛异常', false, e.message); }

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
