'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getConfigDir, getDataDir } = require('./runtime-paths');

const SOURCE_PATHS_CONFIG_FILE = 'source-paths.json';

const SOURCE_ENV_KEYS = {
  claude: 'AGENT_BOARD_CLAUDE_SOURCE_PATH',
  codex: 'AGENT_BOARD_CODEX_SOURCE_PATH',
  workbuddy: 'AGENT_BOARD_WORKBUDDY_SOURCE_PATH',
  workbuddySpool: 'AGENT_BOARD_WORKBUDDY_SPOOL_PATH',
  deepseek: 'AGENT_BOARD_DEEPSEEK_SOURCE_PATH',
  marvis: 'AGENT_BOARD_MARVIS_SOURCE_PATH',
  zcode: 'AGENT_BOARD_ZCODE_SOURCE_PATH',
  pi: 'AGENT_BOARD_PI_SOURCE_PATH',
  hermes: 'AGENT_BOARD_HERMES_SOURCE_PATH',
};

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : platform === 'darwin' ? path.posix : path;
}

function effectiveHome({ env = process.env, homedir = os.homedir(), platform = process.platform } = {}) {
  if (platform === 'win32') return nonBlank(env.USERPROFILE) || homedir;
  return nonBlank(env.HOME) || homedir;
}

function getSourcePathsConfigPath({ env = process.env, homedir = os.homedir(), platform = process.platform } = {}) {
  const pathApi = pathApiFor(platform);
  return pathApi.join(getConfigDir({ env, homedir: effectiveHome({ env, homedir, platform }), platform }), SOURCE_PATHS_CONFIG_FILE);
}

function loadSourcePathOverrides({
  configPath = getSourcePathsConfigPath(),
  fsApi = fs,
} = {}) {
  if (!fsApi || typeof fsApi.existsSync !== 'function' || !fsApi.existsSync(configPath)) return {};
  try {
    const value = JSON.parse(fsApi.readFileSync(configPath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function configValue(overrides, id, field = 'root') {
  const value = overrides && overrides[id];
  if (typeof value === 'string') return nonBlank(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return nonBlank(value[field]);
}

function resolveSourcePaths({
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
  overrides = null,
} = {}) {
  const pathApi = pathApiFor(platform);
  const home = effectiveHome({ env, homedir, platform });
  const appData = nonBlank(env.APPDATA) || pathApi.join(home, 'AppData', 'Roaming');
  const localAppData = nonBlank(env.LOCALAPPDATA) || pathApi.join(home, 'AppData', 'Local');
  const config = overrides || loadSourcePathOverrides({
    configPath: getSourcePathsConfigPath({ env, homedir: home, platform }),
  });
  const envPath = (id) => nonBlank(env[SOURCE_ENV_KEYS[id]]);
  const resolve = (value, fallback) => pathApi.resolve(nonBlank(value) || fallback);
  const root = (id, fallback) => resolve(envPath(id) || configValue(config, id), fallback);
  const field = (id, name, fallback, envKey) => resolve(
    nonBlank(env[envKey]) || configValue(config, id, name),
    fallback,
  );

  const claude = root('claude', pathApi.join(home, '.claude', 'projects'));
  const codex = root('codex', pathApi.join(home, '.codex', 'sessions'));
  const workbuddy = root('workbuddy', pathApi.join(home, '.workbuddy', 'projects'));
  const deepseek = root('deepseek', pathApi.join(home, '.dsh', 'sessions'));
  const marvis = root(
    'marvis',
    platform === 'darwin'
      ? pathApi.join(home, 'Library', 'Application Support', 'Tencent', 'Marvis', 'User')
      : pathApi.join(appData, 'Tencent', 'Marvis', 'User'),
  );
  const zcode = root('zcode', pathApi.join(home, '.zcode', 'cli', 'db'));
  const pi = root('pi', pathApi.join(home, '.pi', 'agent', 'sessions'));
  const hermes = root(
    'hermes',
    platform === 'darwin'
      ? pathApi.join(home, 'Library', 'Application Support', 'hermes')
      : pathApi.join(localAppData, 'hermes'),
  );

  return {
    claude,
    codex,
    codexSessionIndex: field(
      'codex',
      'sessionIndex',
      pathApi.join(home, '.codex', 'session_index.jsonl'),
      'AGENT_BOARD_CODEX_SESSION_INDEX_PATH',
    ),
    workbuddy,
    workbuddyHeartbeat: field(
      'workbuddy',
      'heartbeatDir',
      pathApi.join(home, '.workbuddy', 'sessions'),
      'AGENT_BOARD_WORKBUDDY_HEARTBEAT_PATH',
    ),
    workbuddyDb: field(
      'workbuddy',
      'db',
      pathApi.join(home, '.workbuddy', 'workbuddy.db'),
      'AGENT_BOARD_WORKBUDDY_DB_PATH',
    ),
    workbuddySpool: field(
      'workbuddy',
      'spool',
      pathApi.join(getDataDir({ env, homedir: home, platform }), 'workbuddy', 'events.spool'),
      SOURCE_ENV_KEYS.workbuddySpool,
    ),
    deepseek,
    marvis,
    zcode,
    pi,
    hermes,
    hermesDb: field(
      'hermes',
      'db',
      pathApi.join(hermes, 'state.db'),
      'AGENT_BOARD_HERMES_DB_PATH',
    ),
  };
}

const SOURCE_PATHS = resolveSourcePaths();

module.exports = {
  SOURCE_PATHS_CONFIG_FILE,
  SOURCE_ENV_KEYS,
  SOURCE_PATHS,
  getSourcePathsConfigPath,
  loadSourcePathOverrides,
  resolveSourcePaths,
};
