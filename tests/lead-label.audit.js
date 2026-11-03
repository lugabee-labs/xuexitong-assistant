// Lead 独立验证：题型标签正则 LABEL_RE 的真实行为
// 不依赖 impl / verifier 的用例，用我自己构造的样本。
// 运行：node tests/lead-label.audit.js
//
// 核心命题：LABEL_RE 的语义必须是「整段就是一个题型标签」，
// 而不是「文本里含有题型词」。误判代价远大于漏判：
//   漏判 → 退回 data/结构兜底，还能正常答
//   误判 → 判成简答/计算 → answerSubjective:false → 静默不答

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'xuexitong-assistant.user.js'), 'utf8');

// ---- 从源码里提取 LABEL_RE 与 QTYPE_BY_WORD（测的是真代码，不是副本）----
const reMatch = SRC.match(/const LABEL_RE = (\/[^\n]*?\/);/);
if (!reMatch) {
  console.log('FAIL 没能从源码提取 LABEL_RE');
  process.exit(1);
}
const LABEL_RE = eval(reMatch[1]);

const tableMatch = SRC.match(/const QTYPE_BY_WORD = \{([\s\S]*?)\};/);
const QTYPE_BY_WORD = tableMatch ? eval('({' + tableMatch[1] + '})') : {};

console.log('LABEL_RE 已提取: ' + String(LABEL_RE).slice(0, 90) + '…');
console.log('QTYPE_BY_WORD 词条数: ' + Object.keys(QTYPE_BY_WORD).length);
console.log('');

function labelOf(s) {
  const m = LABEL_RE.exec(String(s || ''));
  if (!m) return null;
  const word = (m[1] || '').replace(/\s+/g, '');
  const key = word.replace(/题$/, '');
  return QTYPE_BY_WORD[key] || QTYPE_BY_WORD[word] || null;
}

let pass = 0, fail = 0;
const fails = [];

// ============ A. 干扰样本：绝对不能被当成题型标签 ============
// 覆盖 论述/填空/判断/计算/简述/选择/多选/名词解释/是非 在非标签位置出现
const NEGATIVE = [
  '以下关于计算机网络的描述，正确的是',
  '关于计算机算法的描述',
  '以下（计算机网络）的说法，正确的是',
  '（填空）以下说法正确的是',
  '下列（判断）是否成立',
  '请（简述）TCP 三次握手',
  '下列（选择）题中，错误的是',
  '（多选）以下哪些属于面向对象特征',
  '计算（1+1）的结果',
  '论述（HTTP/2）的优缺点',
  '判断（A）是否正确',
  '计算结果正确的是',
  '计算机网络的拓扑结构',
  '请填写下表',
  '判断下列说法的正误',
  '简述操作系统的功能',
  '选择正确的答案',
  '多项选择题的目的是什么',
  '这道判断题很难',
  '计算题太难了怎么办',
  '论述题怎么写才好',
  '填空题一共有几个空',
  '单选题应该选哪个',
  '【单选题】HTTP 默认端口是多少',   // 带题干，不应算标签
  '第1题：判断题',
  '1.以下说法正确的是',
  '（计算机网络）',
  '关于（计算机算法）的描述',
  '标签：单选题',
  '题型：多选题',
  '下列是单项选择题的是',
  '以下哪些是多选题',
  '请判断以下说法',
  '求计算过程',
  '撰写论述文章',
];

// ============ B. 正向样本：必须能识别为题型标签 ============
const POSITIVE = [
  ['单选题', 'single'],
  ['单项选择题', 'single'],
  ['【单选题】', 'single'],
  ['（多选题）', 'multiple'],
  ['1.（单选题）', 'single'],
  ['1、【判断题】', 'judge'],
  ['1、多选题', 'multiple'],
  ['判断题（2分）', 'judge'],
  ['（名词解释题）', 'subjective'],
  ['单选题（10分）', 'single'],
  ['  多选题  ', 'multiple'],
  ['填空', 'fill'],
  ['简答题', 'subjective'],
  ['计算题', 'calc'],
  ['论述题', 'subjective'],
  ['是非题', 'judge'],
];

console.log('=== A. 干扰样本（' + NEGATIVE.length + ' 条，全部不应识别为标签）===');
let negBad = 0;
NEGATIVE.forEach((s) => {
  const got = labelOf(s);
  if (got) {
    negBad++;
    fails.push(`干扰样本被误判: ${JSON.stringify(s)} → ${got}`);
  }
});
if (negBad === 0) { pass++; console.log('  ok   ' + NEGATIVE.length + ' 条干扰样本无一被识别为题型标签'); }
else { fail++; console.log('  FAIL ' + negBad + ' 条误判，见下'); }

console.log('\n=== B. 正向样本（' + POSITIVE.length + ' 条，必须识别正确）===');
POSITIVE.forEach(([s, want]) => {
  const got = labelOf(s);
  if (got === want) { pass++; console.log('  ok   ' + JSON.stringify(s) + ' → ' + got); }
  else { fail++; fails.push(`正向失败: ${JSON.stringify(s)} 期望 ${want} 实得 ${got}`); console.log('  FAIL ' + JSON.stringify(s) + ' 期望 ' + want + ' 实得 ' + got); }
});

if (fails.length) {
  console.log('\n=== 失败明细 ===');
  fails.forEach((f) => console.log('  · ' + f));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
