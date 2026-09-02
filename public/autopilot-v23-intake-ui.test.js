'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');

test('每个 Agent 导航和空 Session 状态都连接到真实托管任务流程', () => {
  assert.match(app, /className = 'qa-btn'/);
  assert.doesNotMatch(app, /className = 'qa-new-task'/);
  assert.match(app, /textContent = '新建托管任务'/);
  assert.match(app, /openNewHostedTask\(key\)/);
  assert.match(app, /openNewHostedTask\('codex'/);
  assert.match(app, /project-empty-new-task/);
});

test('Agent 快捷新建任务会阻止全局关闭事件，并放在看板 Agent 名称右侧', () => {
  assert.match(app, /className = 'col-new-task'/);
  assert.match(app, /head\.append\(name|head\.append\(.*col-name.*col-new-task/s);
  assert.match(app, /newTask\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); void openNewHostedTask\(key\); \}\)/);
  assert.match(html, /\.col-new-task/);
});

test('托管任务抽屉包含目录选择、PRD 草稿、配置快照和人工确认链路', () => {
  assert.match(app, /selectHostedProjectFolder/);
  assert.match(app, /hosted-project-path/);
  assert.match(app, /hosted-prd-mode/);
  assert.match(app, /hosted-mode/);
  assert.match(app, /hosted-model/);
  assert.match(app, /hosted-max-budget/);
  assert.match(app, /hosted-allow-network/);
  assert.match(app, /hosted-research-read/);
  assert.match(app, /hosted-research-domains/);
  assert.match(app, /api\/orchestration\/intake\/preview/);
  assert.match(app, /api\/orchestration\/intake\/confirm/);
  assert.match(app, /confirmed: true/);
  assert.match(app, /未点击确认前不会创建 Session、Run、发送任务或执行代码/);
  assert.match(html, /hosted-task-drawer|col-empty-action/);
});

test('确认按钮首次点击会先生成草稿并明确提示再次确认', () => {
  assert.doesNotMatch(app, /id="hosted-confirm" disabled/);
  assert.match(app, /尚未生成 Task Contract 草稿/);
  assert.match(app, /请检查后再次点击确认/);
  assert.match(html, /hosted-task-confirm-hint/);
});

test('合同需要人工处理时确认仍创建 Session，并将 Workflow 暂停', () => {
  assert.match(app, /点击确认即可创建 Session/);
  assert.match(app, /Session 会先进入 NEED_HUMAN/);
});

test('自动生成合同展示分析阶段、独立风险信息和具体缺失字段', () => {
  assert.match(app, /分析目标并生成 Task Contract/);
  assert.match(app, /正在校验项目目录/);
  assert.match(app, /正在读取 PRD/);
  assert.match(app, /正在分析任务复杂度和风险/);
  assert.match(app, /正在生成 Task Contract/);
  assert.match(app, /正在应用安全边界/);
  assert.match(app, /正在校验 Task Contract/);
  assert.match(app, /view\.complexityLabel/);
  assert.match(app, /view\.riskLabel/);
  assert.match(app, /view\.riskReasons/);
  assert.match(app, /view\.assumptions/);
  assert.match(app, /view\.requiredPermissions/);
  assert.match(app, /missingFieldLabels/);
  assert.match(app, /confirmButton\.disabled = true/);
  assert.match(app, /previewButton\.disabled = true/);
  assert.match(app, /本合同仅根据任务目标生成，未读取 PRD。/);
  assert.match(app, /资料研究：/);
  assert.match(app, /AI 正在研究/);
});

test('Task Contract 错误会展示具体字段、权限、原因和建议', () => {
  assert.match(app, /const formatHostedTaskError/);
  assert.match(app, /permissionViolations/);
  assert.match(app, /缺少字段：/);
  assert.match(app, /越界权限：/);
  assert.match(app, /原因：/);
  assert.match(app, /建议：/);
});

test('确认真实 Session 后打开 Codex，并在真实卡片出现前显示承接状态', () => {
  assert.match(app, /data\.session\?\.sessionRef/);
  assert.match(app, /openCodexThread\(data\.session\.sessionRef\)/);
  assert.match(app, /hostedSessionHandoff\.add/);
  assert.match(app, /hosted-session-handoff/);
  assert.match(app, /hostedSessionHandoff\.reconcile/);
});

test('托管承接卡提供只隐藏卡片的手动操作', () => {
  assert.match(app, /function dismissHostedSessionHandoff\(sessionRef\)/);
  assert.match(app, /hosted-session-handoff-dismiss/);
  assert.match(app, /state\.hostedSessionHandoff\.remove/);
  assert.match(app, /真实 Session 和托管任务不受影响/);
});

test('托管承接卡同步后端 Workflow 的暂停原因', () => {
  assert.match(app, /function syncHostedSessionHandoffs\(\)/);
  assert.match(app, /workflow\.lastError/);
  assert.match(app, /托管已暂停：/);
  assert.match(app, /state\.hostedSessionHandoff\.update/);
});

test('Codex 深链结果待确认时仍允许同一真实 Session 通过 app-server 启动托管', () => {
  assert.match(app, /data\.session\?\.transport === 'codex-app-server'/);
  assert.match(app, /codexOpened \|\| nativeCodexSession/);
  assert.match(app, /已通过 app-server 准备启动托管/);
});

test('看板采集稍晚时，托管承接卡超时后仍继续后台收敛', () => {
  assert.match(app, /const deadline = Date\.now\(\) \+ 5 \* 60_000/);
  assert.match(app, /const timer = setTimeout\(check, 10_000\)/);
  assert.match(app, /后续 loadBoard 一旦看到真实 ref，reconcile 会自动移除承接卡/);
});

test('桌面端目录选择只通过安全 IPC 暴露路径', () => {
  assert.match(main, /ipcMain\.handle\('project:select-folder'/);
  assert.match(main, /properties:\s*\['openDirectory'\]/);
  assert.match(preload, /selectProjectFolder/);
});
