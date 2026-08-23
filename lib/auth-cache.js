const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const AUTH_CACHE_PATH = path.join(LOCAL_APP_DATA, 'AgentBoard', 'auth.json');

function isValidAuthCache(cache) {
  return (
    cache !== null &&
    typeof cache === 'object' &&
    !Array.isArray(cache) &&
    Object.keys(cache).length === 2 &&
    typeof cache.token === 'string' &&
    cache.token.length > 0 &&
    Number.isFinite(cache.receivedAt)
  );
}

function loadAuthCache(filePath = AUTH_CACHE_PATH) {
  try {
    const cache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isValidAuthCache(cache) ? cache : null;
  } catch {
    return null;
  }
}

function saveAuthCache(cache, filePath = AUTH_CACHE_PATH) {
  if (!isValidAuthCache(cache)) {
    throw new TypeError('Invalid auth cache');
  }

  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(temporaryPath, JSON.stringify(cache), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function clearAuthCache(filePath = AUTH_CACHE_PATH) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

module.exports = { AUTH_CACHE_PATH, clearAuthCache, loadAuthCache, saveAuthCache };
