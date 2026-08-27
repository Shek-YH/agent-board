'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function credentialsPath() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(dshHome, '.credentials.yaml');
}

function repairCredentialsText(input) {
  const text = String(input || '');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const refsIndex = lines.findIndex((line) => /^refs:\s*$/.test(line));
  const legacyIndexes = [];
  lines.forEach((line, index) => {
    if (/^ECHOBIRD_API_KEY\s*:/.test(line)) legacyIndexes.push(index);
  });
  if (!legacyIndexes.length) return { changed: false, text };
  if (refsIndex < 0) {
    return { changed: false, text, error: '凭据文件缺少 refs 区段，无法安全迁移 ECHOBIRD_API_KEY' };
  }
  for (const index of legacyIndexes) lines[index] = `  ${lines[index].trim()}`;
  return { changed: true, text: lines.join(newline) };
}

function repairCredentialsFile(filePath = credentialsPath()) {
  if (!fs.existsSync(filePath)) return { changed: false, path: filePath };
  let input;
  try {
    input = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { changed: false, path: filePath, error: `无法读取凭据文件：${error.message}` };
  }
  const result = repairCredentialsText(input);
  if (!result.changed || result.error) return { ...result, path: filePath };
  const backupPath = `${filePath}.agent-board-backup`;
  try {
    if (!fs.existsSync(backupPath)) fs.copyFileSync(filePath, backupPath);
    fs.writeFileSync(filePath, result.text, 'utf8');
    return { changed: true, repaired: true, path: filePath, backupPath };
  } catch (error) {
    return { changed: false, path: filePath, error: `无法保存凭据文件：${error.message}` };
  }
}

module.exports = { credentialsPath, repairCredentialsText, repairCredentialsFile };
