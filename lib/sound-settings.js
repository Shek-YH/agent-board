const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SOUND_DIR = process.env.AGENT_BOARD_SOUND_DIR || path.join(__dirname, '..', 'public', 'sounds');
const UPLOAD_DIR = path.join(SOUND_DIR, 'uploads');
const SETTINGS_PATH = path.join(SOUND_DIR, 'sound-settings.json');
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_TYPES = {
  'audio/aac': 'aac',
  'audio/m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

function emptySettings() {
  return { assignments: {}, sounds: [] };
}

function pathsFor(paths = {}) {
  const settingsPath = paths.settingsPath || SETTINGS_PATH;
  return { settingsPath, uploadDir: paths.uploadDir || path.join(path.dirname(settingsPath), 'uploads') };
}

function validSound(sound) {
  return sound && typeof sound === 'object' && typeof sound.id === 'string' && typeof sound.name === 'string'
    && typeof sound.mime === 'string' && typeof sound.url === 'string';
}

function loadSoundSettings(paths) {
  try {
    const settings = JSON.parse(fs.readFileSync(pathsFor(paths).settingsPath, 'utf8'));
    const disabledAgents = settings && settings.disabledAgents === undefined ? [] : settings?.disabledAgents;
    const disabledSubagentAgents = settings && settings.disabledSubagentAgents === undefined ? [] : settings?.disabledSubagentAgents;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
      || !Array.isArray(settings.sounds) || !settings.sounds.every(validSound)
      || !settings.assignments || typeof settings.assignments !== 'object' || Array.isArray(settings.assignments)
      || !Object.values(settings.assignments).every((id) => typeof id === 'string')
      || !Array.isArray(disabledAgents) || !disabledAgents.every((agent) => typeof agent === 'string' && agent)
      || !Array.isArray(disabledSubagentAgents) || !disabledSubagentAgents.every((agent) => typeof agent === 'string' && agent)) return emptySettings();
    const result = { assignments: { ...settings.assignments }, sounds: settings.sounds.map((sound) => ({ ...sound })) };
    const uniqueDisabledAgents = [...new Set(disabledAgents)];
    if (uniqueDisabledAgents.length) result.disabledAgents = uniqueDisabledAgents;
    const uniqueDisabledSubagentAgents = [...new Set(disabledSubagentAgents)];
    if (uniqueDisabledSubagentAgents.length) result.disabledSubagentAgents = uniqueDisabledSubagentAgents;
    return result;
  } catch {
    return emptySettings();
  }
}

function atomicWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, data);
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function saveSoundSettings(settings, paths) {
  atomicWrite(pathsFor(paths).settingsPath, JSON.stringify(settings));
  return settings;
}

function parseAudioDataUrl(dataUrl) {
  const match = typeof dataUrl === 'string' && dataUrl.match(/^data:([^;]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || !AUDIO_TYPES[match[1].toLowerCase()]) throw new TypeError('Unsupported audio upload');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.toString('base64') !== match[2]) throw new TypeError('Invalid audio encoding');
  if (data.length > MAX_AUDIO_BYTES) throw new RangeError('Audio upload too large');
  return { data, extension: AUDIO_TYPES[match[1].toLowerCase()], mime: match[1].toLowerCase() === 'audio/x-wav' ? 'audio/wav' : match[1].toLowerCase() };
}

function displayName(name, extension) {
  const cleaned = String(name || '完成提示音')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned || `完成提示音.${extension}`;
}

function uploadSound({ dataUrl, name }, paths) {
  const { data, extension, mime } = parseAudioDataUrl(dataUrl);
  const resolved = pathsFor(paths);
  const id = randomUUID();
  const filename = `${id}.${extension}`;
  const filePath = path.join(resolved.uploadDir, filename);
  const sound = { id, mime, name: displayName(name, extension), url: `/sounds/uploads/${filename}` };
  atomicWrite(filePath, data);
  try {
    const settings = loadSoundSettings(resolved);
    settings.sounds.push(sound);
    saveSoundSettings(settings, resolved);
    return sound;
  } catch (error) {
    try { fs.unlinkSync(filePath); } catch {}
    throw error;
  }
}

function assignSound(agent, soundId, paths) {
  if (typeof agent !== 'string' || !agent) throw new TypeError('Invalid agent');
  const settings = loadSoundSettings(paths);
  if (soundId) {
    if (!settings.sounds.some((sound) => sound.id === soundId)) throw new RangeError('Sound not found');
    settings.assignments[agent] = soundId;
  } else {
    delete settings.assignments[agent];
  }
  return saveSoundSettings(settings, paths);
}

function cloneSettings(settings) {
  const next = { assignments: { ...settings.assignments }, sounds: settings.sounds.map((sound) => ({ ...sound })) };
  if (settings.disabledAgents?.length) next.disabledAgents = [...settings.disabledAgents];
  if (settings.disabledSubagentAgents?.length) next.disabledSubagentAgents = [...settings.disabledSubagentAgents];
  return next;
}

function setDisabledAgents(field, agents, enabled, paths) {
  if (!Array.isArray(agents) || !agents.length || !agents.every((agent) => typeof agent === 'string' && agent)) {
    throw new TypeError('Invalid agents');
  }
  if (typeof enabled !== 'boolean') throw new TypeError('Invalid sound enabled state');
  const settings = loadSoundSettings(paths);
  const disabledAgents = new Set(settings[field] || []);
  for (const agent of new Set(agents)) {
    if (enabled) disabledAgents.delete(agent);
    else disabledAgents.add(agent);
  }
  const next = cloneSettings(settings);
  if (disabledAgents.size) next[field] = [...disabledAgents].sort();
  else delete next[field];
  return saveSoundSettings(next, paths);
}

function setSoundEnabled(agent, enabled, paths) {
  if (typeof agent !== 'string' || !agent) throw new TypeError('Invalid agent');
  return setDisabledAgents('disabledAgents', [agent], enabled, paths);
}

function setSoundsEnabled(agents, enabled, paths) {
  return setDisabledAgents('disabledAgents', agents, enabled, paths);
}

function setSubagentSoundEnabled(agent, enabled, paths) {
  if (typeof agent !== 'string' || !agent) throw new TypeError('Invalid agent');
  return setDisabledAgents('disabledSubagentAgents', [agent], enabled, paths);
}

function setSubagentSoundsEnabled(agents, enabled, paths) {
  return setDisabledAgents('disabledSubagentAgents', agents, enabled, paths);
}

function deleteSound(soundId, paths) {
  if (typeof soundId !== 'string' || !soundId) throw new TypeError('Invalid sound id');
  const resolved = pathsFor(paths);
  const settings = loadSoundSettings(resolved);
  const index = settings.sounds.findIndex((sound) => sound.id === soundId);
  if (index === -1) throw new RangeError('Sound not found');

  const [sound] = settings.sounds.splice(index, 1);
  for (const [agent, assignedId] of Object.entries(settings.assignments)) {
    if (assignedId === soundId) delete settings.assignments[agent];
  }
  try {
    fs.unlinkSync(path.join(resolved.uploadDir, path.basename(sound.url)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return saveSoundSettings(settings, resolved);
}

module.exports = {
  AUDIO_TYPES, MAX_AUDIO_BYTES, SOUND_DIR, SETTINGS_PATH, UPLOAD_DIR,
  assignSound, deleteSound, loadSoundSettings, setSoundEnabled, setSoundsEnabled,
  setSubagentSoundEnabled, setSubagentSoundsEnabled, uploadSound,
};
