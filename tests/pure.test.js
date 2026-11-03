// 纯函数单测：直接从 user.js 抽取同名实现，验证行为契约
// 运行：node tests/pure.test.js

function norm(s) {
  return String(s || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；：、“”‘’（）()【】\[\]<>《》?!？！.,;:'"\-_/\\]/g, '')
    .toLowerCase();
}

function parseAiAnswer(text, options) {
  let t = String(text || '').replace(/[*`#]/g, '').trim();
  if (!t) return '';
  t = t.replace(/^(答案|正确答案|答)\s*[:：]?\s*/, '').trim();
  if (options && options.length) {
    const compact = t.toUpperCase().replace(/[\s,，、;；/和与]/g, '');
    if (/^[A-H]{1,8}$/.test(compact)) {
      const letters = compact.split('').filter((c, i, arr) => arr.indexOf(c) === i);
      if (letters.every((c) => c.charCodeAt(0) - 65 < options.length)) return letters.join('');
    }
    const run = t.toUpperCase().match(/[A-H]{1,8}/);
    if (run) {
      const letters = run[0].split('').filter((c, i, arr) => arr.indexOf(c) === i);
      if (letters.every((c) => c.charCodeAt(0) - 65 < options.length)) return letters.join('');
    }
    if (/^(错|错误|否|×|✗|false|F)/i.test(t)) return '错';
    if (/^(对|正确|是|√|✓|true|T)/i.test(t)) return '对';
  }
  return t;
}

function pickIndexes(options, answer) {
  const picked = new Set();
  if (!answer) return picked;
  const raw = String(answer).trim();
  if (/^[A-Ha-h][A-Ha-h\s,，、;；/]*$/.test(raw)) {
    raw.toUpperCase().split('').forEach((ch) => {
      const i = ch.charCodeAt(0) - 65;
      if (i >= 0 && i < options.length) picked.add(i);
    });
    if (picked.size) return picked;
  }
  if (/^(对|正确|是|√|✓|t|true)/i.test(raw)) {
    options.forEach((o, i) => { if (/对|正确|是|√|✓/.test(o.text)) picked.add(i); });
    if (picked.size) return picked;
  }
  if (/^(错|错误|否|×|✗|f|false)/i.test(raw)) {
    options.forEach((o, i) => { if (/错|错误|否|×|✗/.test(o.text)) picked.add(i); });
    if (picked.size) return picked;
  }
  const na = norm(raw);
  options.forEach((o, i) => {
    const no = norm(o.text);
    if (no && (no === na || no.includes(na) || na.includes(no))) picked.add(i);
  });
  return picked;
}

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log('FAIL', name, '\n  got :', g, '\n  want:', w); }
}

// ---- norm ----
eq('norm 去空白标点', norm(' 中国， 人民。 '), '中国人民');
eq('norm 全角空格', norm('a\u3000b'), 'ab');
eq('norm 小写', norm('ABC'), 'abc');

// ---- parseAiAnswer ----
const opts4 = [{text:'甲'},{text:'乙'},{text:'丙'},{text:'丁'}];
eq('单字母', parseAiAnswer('A', opts4), 'A');
eq('带答案前缀', parseAiAnswer('答案：B', opts4), 'B');
eq('多选连写', parseAiAnswer('ABD', opts4), 'ABD');
eq('多选带分隔', parseAiAnswer('A、C', opts4), 'AC');
eq('越界字母', parseAiAnswer('Z', opts4), 'Z');   // Z 不在 A-H，回落原文
eq('判断题对', parseAiAnswer('对', opts4), '对');
eq('判断题错', parseAiAnswer('错误', opts4), '错');
eq('空输入', parseAiAnswer('', opts4), '');
eq('超范围多选', parseAiAnswer('E', opts4), 'E'); // 只有4项，E 越界回落原文

// ---- pickIndexes ----
eq('单选 A', [...pickIndexes(opts4, 'A')], [0]);
eq('多选 AB', [...pickIndexes(opts4, 'AB')].sort(), [0,1]);
eq('判断题对', [...pickIndexes([{text:'正确'},{text:'错误'}], '对')], [0]);
eq('判断题错', [...pickIndexes([{text:'正确'},{text:'错误'}], '错')], [1]);
eq('原文匹配', [...pickIndexes([{text:'计算机网络'},{text:'操作系统'}], '操作系统')], [1]);
eq('无答案', [...pickIndexes(opts4, null)], []);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
