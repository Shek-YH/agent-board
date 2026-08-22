'use strict';
// checkDesktopIdle 单元测试：用真实模块 + 临时 jsonl 文件，验证各分支
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_DIR = path.join(os.homedir(), '.workbuddy', 'projects', '__idle_check_test__');
const REAL_DATE_NOW = Date.now;
let seq = 0;

function makeJsonl(sessionId, lastLineType) {
  const now = Date.now();
  const lines = [
    JSON.stringify({ type: 'message', role: 'user', timestamp: now - 120000, sessionId, cwd: TEST_DIR, content: [{ type: 'input_text', text: '测试问题' }], status: 'completed' }),
    JSON.stringify({ type: 'message', role: 'assistant', timestamp: now - 60000, sessionId, cwd: TEST_DIR, content: [{ type: 'output_text', text: '测试回答' }], status: 'completed' }),
  ];
  if (lastLineType === 'function_call') {
    lines.push(JSON.stringify({ type: 'function_call', timestamp: now - 30000, sessionId, cwd: TEST_DIR, name: 'bash', arguments: '{}' }));
  } else if (lastLineType === 'reasoning') {
    lines.push(JSON.stringify({ type: 'reasoning', timestamp: now - 30000, sessionId, cwd: TEST_DIR, content: [] }));
  } else if (lastLineType === 'ai-title') {
    lines.push(JSON.stringify({ type: 'ai-title', timestamp: now - 30000, sessionId, cwd: TEST_DIR, aiTitle: '标题' }));
  }
  return lines.join('\n') + '\n';
}

function setMtime(file, minutesAgo) {
  const t = new Date(Date.now() - minutesAgo * 60 * 1000);
  fs.utimesSync(file, t, t);
}

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

try {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const wb = require('./lib/adapters/workbuddy.js');

  // 每个用例用独立 sessionId，避免模块级 deskIdleSince 状态串扰
  function runCase({ lastRole, lastLineType, mtimeMinAgo, times = 1, advanceMs = 0 }) {
    const sid = `idle-test-${++seq}`;
    const file = path.join(TEST_DIR, `${sid}.jsonl`);
    const ref = `workbuddy:${sid}`;
    const calls = [];
    const mockStore = {
      getLastRole(r) { return r === ref ? lastRole : null; },
      setAgentActive(r, alive, ts) { calls.push({ ref: r, alive, ts }); },
    };
    fs.writeFileSync(file, makeJsonl(sid, lastLineType), 'utf8');
    setMtime(file, mtimeMinAgo);
    for (let i = 0; i < times; i++) {
      if (i > 0 && advanceMs > 0) Date.now = () => REAL_DATE_NOW() + advanceMs * i; // 模拟时间流逝（防抖间隔）
      wb.checkDesktopIdle(mockStore);
      Date.now = REAL_DATE_NOW;
    }
    // 只看本测试会话的调用（checkDesktopIdle 会遍历 ROOT 下全部真实文件，mock 也会收到真实 ref 的调用）
    return { calls: calls.filter((c) => c.ref === ref) };
  }

  console.log('用例1: assistant 结尾 + 静止 5 分钟 + 末行 message → 第一次不判（防抖开始），40s 后第二次判停止');
  {
    const r1 = runCase({ lastRole: 'assistant', lastLineType: 'message', mtimeMinAgo: 5 });
    assert('第一次检查无动作', r1.calls.length === 0, JSON.stringify(r1.calls));
    const r2 = runCase({ lastRole: 'assistant', lastLineType: 'message', mtimeMinAgo: 5, times: 2, advanceMs: 50000 });
    assert('40s 后第二次检查判停止', r2.calls.length === 1 && r2.calls[0].alive === false, JSON.stringify(r2.calls));
  }

  console.log('用例2: 文件刚写（1 秒前）→ 判活跃');
  {
    const { calls } = runCase({ lastRole: 'assistant', lastLineType: 'message', mtimeMinAgo: 0 });
    assert('调用 setAgentActive(ref, true)', calls.length === 1 && calls[0].alive === true, JSON.stringify(calls));
  }

  console.log('用例3: 静止 5 分钟但末行是 function_call（长工具执行中）→ 不判停止');
  {
    const { calls } = runCase({ lastRole: 'assistant', lastLineType: 'function_call', mtimeMinAgo: 5 });
    assert('无动作', calls.length === 0, JSON.stringify(calls));
  }

  console.log('用例4a: 最后消息 user + 文件在写 → 清除停止标记（判活跃）');
  {
    const { calls } = runCase({ lastRole: 'user', lastLineType: 'message', mtimeMinAgo: 0 });
    assert('调用 setAgentActive(ref, true)', calls.length === 1 && calls[0].alive === true, JSON.stringify(calls));
  }
  console.log('用例4b: 最后消息 user + 文件静止 5 分钟 → 不判（等 agent 回复，10 分钟窗口兜底）');
  {
    const { calls } = runCase({ lastRole: 'user', lastLineType: 'message', mtimeMinAgo: 5 });
    assert('无动作', calls.length === 0, JSON.stringify(calls));
  }

  console.log('用例5: 静止 3.5 分钟（210s < 240s 阈值，agent 最长工作间隙）→ 不判');
  {
    const { calls } = runCase({ lastRole: 'assistant', lastLineType: 'message', mtimeMinAgo: 3.5 });
    assert('无动作', calls.length === 0, JSON.stringify(calls));
  }

  console.log('用例6: 末行是 reasoning（agent 思考中）→ 不判');
  {
    const { calls } = runCase({ lastRole: 'assistant', lastLineType: 'reasoning', mtimeMinAgo: 5 });
    assert('无动作', calls.length === 0, JSON.stringify(calls));
  }

  console.log('用例7: 末行是 ai-title → 不判（10 分钟窗口兜底）');
  {
    const { calls } = runCase({ lastRole: 'assistant', lastLineType: 'ai-title', mtimeMinAgo: 5 });
    assert('无动作', calls.length === 0, JSON.stringify(calls));
  }
} finally {
  Date.now = REAL_DATE_NOW;
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
