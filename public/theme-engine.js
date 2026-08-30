(function attachThemeEngine(root) {
  'use strict';

  const THEME_SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'agent-board-theme';
  const SYSTEM_THEME_ID = 'system';
  const REQUIRED_TOKENS = [
    'background', 'foreground', 'muted', 'mutedForeground', 'border', 'input', 'ring',
    'surface', 'surfaceForeground', 'surfaceHover', 'surfaceActive', 'elevated', 'elevatedForeground',
    'primary', 'primaryForeground', 'secondary', 'secondaryForeground', 'accent', 'accentForeground',
    'success', 'successForeground', 'warning', 'warningForeground', 'danger', 'dangerForeground', 'info', 'infoForeground',
    'agentIdle', 'agentRunning', 'agentWaiting', 'agentCompleted', 'agentError', 'agentPaused',
    'sessionBackground', 'sessionForeground', 'sessionBorder', 'sessionHover', 'sessionSelected',
    'sessionSelectedForeground', 'sessionRunning', 'sessionCompleted', 'sessionError',
    'sidebarBackground', 'sidebarForeground', 'sidebarBorder', 'sidebarHover', 'sidebarActive',
    'sidebarActiveForeground', 'sidebarMuted',
    'inputBackground', 'inputForeground', 'inputBorder', 'inputPlaceholder', 'inputFocusBorder', 'inputFocusRing',
    'codeBackground', 'codeForeground', 'codeBorder', 'codeMuted', 'terminalBackground', 'terminalForeground',
    'scrollbarTrack', 'scrollbarThumb', 'scrollbarThumbHover',
    'overlayBackground', 'dialogBackground', 'dialogForeground', 'popoverBackground', 'popoverForeground',
    'tooltipBackground', 'tooltipForeground',
  ];
  const EFFECT_VALUES = {
    glow: new Set(['none', 'soft', 'neon']),
    noise: new Set(['none', 'subtle']),
    shadow: new Set(['none', 'soft', 'deep']),
    motion: new Set(['none', 'subtle']),
    radiusPreset: new Set(['compact', 'normal', 'soft']),
  };
  const THEME_ALIASES = Object.freeze({
    crt: 'crt-green',
    'crt_green': 'crt-green',
    'crt green': 'crt-green',
    default: SYSTEM_THEME_ID,
  });

  const LIGHT_TOKENS = {
    background: '#F8FAFC', foreground: '#0F172A', muted: '#F1F5F9', mutedForeground: '#64748B',
    border: '#E2E8F0', input: '#CBD5E1', ring: '#3B82F6',
    surface: '#FFFFFF', surfaceForeground: '#0F172A', surfaceHover: '#F8FAFC', surfaceActive: '#EFF6FF',
    elevated: '#FFFFFF', elevatedForeground: '#0F172A',
    primary: '#2563EB', primaryForeground: '#FFFFFF', secondary: '#E2E8F0', secondaryForeground: '#1E293B',
    accent: '#3B82F6', accentForeground: '#FFFFFF', accentBackground: '#EFF6FF',
    success: '#16A34A', successForeground: '#FFFFFF', warning: '#D97706', warningForeground: '#FFFFFF',
    danger: '#DC2626', dangerForeground: '#FFFFFF', info: '#0891B2', infoForeground: '#FFFFFF',
    agentIdle: '#94A3B8', agentRunning: '#16A34A', agentWaiting: '#D97706', agentCompleted: '#0F766E',
    agentError: '#DC2626', agentPaused: '#64748B',
    sessionBackground: '#FFFFFF', sessionForeground: '#0F172A', sessionBorder: '#E2E8F0', sessionHover: '#F8FAFC',
    sessionSelected: '#EFF6FF', sessionSelectedForeground: '#1D4ED8', sessionRunning: '#F0FDF4',
    sessionCompleted: '#F8FAFC', sessionError: '#FEF2F2',
    sidebarBackground: '#FFFFFF', sidebarForeground: '#334155', sidebarBorder: '#E2E8F0', sidebarHover: '#F8FAFC',
    sidebarActive: '#EFF6FF', sidebarActiveForeground: '#1D4ED8', sidebarMuted: '#94A3B8',
    inputBackground: '#FFFFFF', inputForeground: '#0F172A', inputBorder: '#CBD5E1', inputPlaceholder: '#94A3B8',
    inputFocusBorder: '#3B82F6', inputFocusRing: 'rgba(59,130,246,.18)',
    codeBackground: '#0F172A', codeForeground: '#E2E8F0', codeBorder: '#334155', codeMuted: '#94A3B8',
    terminalBackground: '#0B1120', terminalForeground: '#C7F9CC',
    scrollbarTrack: '#F1F5F9', scrollbarThumb: '#CBD5E1', scrollbarThumbHover: '#94A3B8',
    overlayBackground: 'rgba(15,23,42,.35)', dialogBackground: '#FFFFFF', dialogForeground: '#0F172A',
    popoverBackground: '#FFFFFF', popoverForeground: '#0F172A', tooltipBackground: '#0F172A', tooltipForeground: '#FFFFFF',
  };

  const DARK_TOKENS = {
    background: '#111827', foreground: '#F8FAFC', muted: '#1F2937', mutedForeground: '#94A3B8',
    border: '#374151', input: '#475569', ring: '#60A5FA',
    surface: '#1F2937', surfaceForeground: '#F8FAFC', surfaceHover: '#273449', surfaceActive: '#243B63',
    elevated: '#263244', elevatedForeground: '#F8FAFC',
    primary: '#60A5FA', primaryForeground: '#0F172A', secondary: '#334155', secondaryForeground: '#E2E8F0',
    accent: '#60A5FA', accentForeground: '#0F172A', accentBackground: 'rgba(96,165,250,.16)',
    success: '#4ADE80', successForeground: '#052E16', warning: '#FBBF24', warningForeground: '#451A03',
    danger: '#F87171', dangerForeground: '#450A0A', info: '#67E8F9', infoForeground: '#083344',
    agentIdle: '#94A3B8', agentRunning: '#4ADE80', agentWaiting: '#FBBF24', agentCompleted: '#2DD4BF',
    agentError: '#F87171', agentPaused: '#94A3B8',
    sessionBackground: '#1F2937', sessionForeground: '#F8FAFC', sessionBorder: '#374151', sessionHover: '#273449',
    sessionSelected: 'rgba(96,165,250,.16)', sessionSelectedForeground: '#BFDBFE', sessionRunning: 'rgba(74,222,128,.12)',
    sessionCompleted: '#1F2937', sessionError: 'rgba(248,113,113,.14)',
    sidebarBackground: '#0F172A', sidebarForeground: '#E2E8F0', sidebarBorder: '#334155', sidebarHover: '#1E293B',
    sidebarActive: 'rgba(96,165,250,.16)', sidebarActiveForeground: '#BFDBFE', sidebarMuted: '#94A3B8',
    inputBackground: '#111827', inputForeground: '#F8FAFC', inputBorder: '#475569', inputPlaceholder: '#94A3B8',
    inputFocusBorder: '#60A5FA', inputFocusRing: 'rgba(96,165,250,.24)',
    codeBackground: '#0B1120', codeForeground: '#E2E8F0', codeBorder: '#334155', codeMuted: '#94A3B8',
    terminalBackground: '#020617', terminalForeground: '#BBF7D0',
    scrollbarTrack: '#1F2937', scrollbarThumb: '#475569', scrollbarThumbHover: '#64748B',
    overlayBackground: 'rgba(2,6,23,.68)', dialogBackground: '#1F2937', dialogForeground: '#F8FAFC',
    popoverBackground: '#1F2937', popoverForeground: '#F8FAFC', tooltipBackground: '#F8FAFC', tooltipForeground: '#0F172A',
  };

  const EFFECT_DEFAULTS = Object.freeze({
    glow: 'none', scanlines: false, gradientBackground: false, noise: 'none', shadow: 'soft', motion: 'none', radiusPreset: 'normal',
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function merge(base, overrides) {
    return Object.assign({}, base, overrides || {});
  }

  function makeTheme(id, name, description, scheme, overrides, effects, metadata = {}) {
    const base = scheme === 'dark' ? DARK_TOKENS : LIGHT_TOKENS;
    const tokens = merge(base, overrides);
    const effectProfile = merge(EFFECT_DEFAULTS, effects);
    const definition = {
      id, name, description, scheme, builtin: true, version: 1, tokens, effects: effectProfile,
      metadata: Object.assign({ author: 'Agent Board', source: 'internal', license: 'MIT', premium: false }, metadata),
      preview: { background: tokens.background, surface: tokens.surface, primary: tokens.primary, foreground: tokens.foreground },
    };
    return Object.freeze(definition);
  }

  const builtinThemes = Object.freeze([
    makeTheme('light', '浅色', '清晰、稳定的商业办公主题。', 'light', {}, { shadow: 'soft' }),
    makeTheme('dark', '深色', '适合长时间使用的低疲劳深色主题。', 'dark', {}, { shadow: 'soft' }),
    makeTheme('arctic', 'Arctic', '冰蓝、冷白和蓝灰组成的专业科技主题。', 'light', {
      background: '#EEF6FB', surface: '#F8FCFF', surfaceHover: '#F0F8FF', surfaceActive: '#DFF2FF',
      primary: '#1687B8', accent: '#16A3C7', accentBackground: '#E5F7FC', border: '#C9E2EF',
      sessionSelected: '#E5F7FC', sessionSelectedForeground: '#0E7490', sidebarActive: '#E5F7FC', sidebarActiveForeground: '#0E7490',
    }, { glow: 'soft', gradientBackground: true, shadow: 'soft', radiusPreset: 'soft' }),
    makeTheme('crt-green', 'CRT Green', '墨绿磷光、轻量扫描线和终端感。', 'dark', {
      background: '#07140A', foreground: '#D5FFE0', muted: '#102619', mutedForeground: '#79B98B', border: '#214D2C',
      input: '#2D713E', ring: '#5CFF7A', surface: '#0B1F11', surfaceForeground: '#D5FFE0', surfaceHover: '#12351C', surfaceActive: '#174D25',
      elevated: '#102619', elevatedForeground: '#D5FFE0', primary: '#5CFF7A', primaryForeground: '#07140A', secondary: '#214D2C',
      secondaryForeground: '#D5FFE0', accent: '#5CFF7A', accentForeground: '#07140A', accentBackground: 'rgba(92,255,122,.16)',
      success: '#5CFF7A', warning: '#E6D86A', danger: '#FF7A7A', info: '#7AE8FF',
      agentIdle: '#79B98B', agentRunning: '#5CFF7A', agentWaiting: '#E6D86A', agentCompleted: '#7AE8FF', agentError: '#FF7A7A', agentPaused: '#79B98B',
      sessionBackground: '#0B1F11', sessionForeground: '#D5FFE0', sessionBorder: '#214D2C', sessionHover: '#12351C', sessionSelected: '#174D25',
      sessionSelectedForeground: '#B9FFC5', sessionRunning: 'rgba(92,255,122,.14)', sessionCompleted: '#0B1F11', sessionError: 'rgba(255,122,122,.14)',
      sidebarBackground: '#051008', sidebarForeground: '#C1F7CC', sidebarBorder: '#214D2C', sidebarHover: '#0B1F11', sidebarActive: '#174D25', sidebarActiveForeground: '#B9FFC5', sidebarMuted: '#79B98B',
      inputBackground: '#07140A', inputForeground: '#D5FFE0', inputBorder: '#2D713E', inputPlaceholder: '#79B98B', inputFocusBorder: '#5CFF7A', inputFocusRing: 'rgba(92,255,122,.24)',
      codeBackground: '#020803', codeForeground: '#D5FFE0', codeBorder: '#214D2C', codeMuted: '#79B98B', terminalBackground: '#020803', terminalForeground: '#5CFF7A',
      scrollbarTrack: '#0B1F11', scrollbarThumb: '#2D713E', scrollbarThumbHover: '#5CFF7A', overlayBackground: 'rgba(2,8,3,.72)', dialogBackground: '#0B1F11', dialogForeground: '#D5FFE0', popoverBackground: '#0B1F11', popoverForeground: '#D5FFE0', tooltipBackground: '#D5FFE0', tooltipForeground: '#07140A',
    }, { glow: 'soft', scanlines: true, noise: 'subtle', shadow: 'none', motion: 'subtle', radiusPreset: 'compact' }),
    makeTheme('ember', 'Ember', '碳黑、深棕与暖橙组成的高端暗黑主题。', 'dark', {
      background: '#1A1110', foreground: '#FFF7ED', muted: '#2B1B17', mutedForeground: '#C4A59A', border: '#5B3429', input: '#75412E', ring: '#FB923C',
      surface: '#251713', surfaceForeground: '#FFF7ED', surfaceHover: '#34201A', surfaceActive: '#4A281D', elevated: '#301D17', elevatedForeground: '#FFF7ED',
      primary: '#FB923C', primaryForeground: '#2B1105', secondary: '#5B3429', secondaryForeground: '#FFE4D0', accent: '#F97316', accentForeground: '#2B1105', accentBackground: 'rgba(249,115,22,.17)',
      success: '#86EFAC', warning: '#FBBF24', danger: '#FB7185', info: '#67E8F9', agentIdle: '#A98D82', agentRunning: '#86EFAC', agentWaiting: '#FBBF24', agentCompleted: '#FDBA74', agentError: '#FB7185', agentPaused: '#A98D82',
      sessionBackground: '#251713', sessionForeground: '#FFF7ED', sessionBorder: '#5B3429', sessionHover: '#34201A', sessionSelected: '#4A281D', sessionSelectedForeground: '#FED7AA', sessionRunning: 'rgba(134,239,172,.12)', sessionCompleted: '#251713', sessionError: 'rgba(251,113,133,.14)',
      sidebarBackground: '#140B09', sidebarForeground: '#FEEBDD', sidebarBorder: '#5B3429', sidebarHover: '#251713', sidebarActive: '#4A281D', sidebarActiveForeground: '#FED7AA', sidebarMuted: '#A98D82', inputBackground: '#1A1110', inputForeground: '#FFF7ED', inputBorder: '#75412E', inputPlaceholder: '#A98D82', inputFocusBorder: '#FB923C', inputFocusRing: 'rgba(251,146,60,.24)',
      codeBackground: '#120907', codeForeground: '#FFE4D0', codeBorder: '#5B3429', codeMuted: '#A98D82', terminalBackground: '#0B0605', terminalForeground: '#FED7AA', scrollbarTrack: '#251713', scrollbarThumb: '#75412E', scrollbarThumbHover: '#FB923C', overlayBackground: 'rgba(11,6,5,.72)', dialogBackground: '#251713', dialogForeground: '#FFF7ED', popoverBackground: '#251713', popoverForeground: '#FFF7ED', tooltipBackground: '#FFF7ED', tooltipForeground: '#1A1110',
    }, { glow: 'soft', shadow: 'deep', motion: 'subtle' }),
    makeTheme('miami', 'Miami', '深蓝背景、青色和粉色的夜间霓虹主题。', 'dark', {
      background: '#071326', foreground: '#F0F9FF', muted: '#10233D', mutedForeground: '#8FAAC5', border: '#25466B', input: '#35638E', ring: '#22D3EE', surface: '#0D1D35', surfaceForeground: '#F0F9FF', surfaceHover: '#142947', surfaceActive: '#1C3B5E', elevated: '#132743', elevatedForeground: '#F0F9FF',
      primary: '#22D3EE', primaryForeground: '#05212D', secondary: '#334B75', secondaryForeground: '#E0E7FF', accent: '#F472B6', accentForeground: '#330A25', accentBackground: 'rgba(244,114,182,.16)', success: '#4ADE80', warning: '#FBBF24', danger: '#FB7185', info: '#22D3EE', agentIdle: '#8FAAC5', agentRunning: '#4ADE80', agentWaiting: '#FBBF24', agentCompleted: '#22D3EE', agentError: '#FB7185', agentPaused: '#8FAAC5',
      sessionBackground: '#0D1D35', sessionForeground: '#F0F9FF', sessionBorder: '#25466B', sessionHover: '#142947', sessionSelected: '#1C3B5E', sessionSelectedForeground: '#A5F3FC', sessionRunning: 'rgba(74,222,128,.12)', sessionCompleted: '#0D1D35', sessionError: 'rgba(251,113,133,.14)', sidebarBackground: '#05101F', sidebarForeground: '#D9F0FF', sidebarBorder: '#25466B', sidebarHover: '#0D1D35', sidebarActive: '#1C3B5E', sidebarActiveForeground: '#A5F3FC', sidebarMuted: '#8FAAC5', inputBackground: '#071326', inputForeground: '#F0F9FF', inputBorder: '#35638E', inputPlaceholder: '#8FAAC5', inputFocusBorder: '#22D3EE', inputFocusRing: 'rgba(34,211,238,.24)', codeBackground: '#040B18', codeForeground: '#D9F0FF', codeBorder: '#25466B', codeMuted: '#8FAAC5', terminalBackground: '#020712', terminalForeground: '#A5F3FC', scrollbarTrack: '#0D1D35', scrollbarThumb: '#35638E', scrollbarThumbHover: '#22D3EE', overlayBackground: 'rgba(2,7,18,.72)', dialogBackground: '#0D1D35', dialogForeground: '#F0F9FF', popoverBackground: '#0D1D35', popoverForeground: '#F0F9FF', tooltipBackground: '#F0F9FF', tooltipForeground: '#071326',
    }, { glow: 'neon', gradientBackground: true, shadow: 'deep', motion: 'subtle' }),
    makeTheme('synthwave', 'Synthwave', '深紫、粉、青和轻量霓虹的 80s cyber 主题。', 'dark', {
      background: '#120D2B', foreground: '#FAF5FF', muted: '#241847', mutedForeground: '#B8A8D4', border: '#513A7A', input: '#6E4FA0', ring: '#E879F9', surface: '#1C133D', surfaceForeground: '#FAF5FF', surfaceHover: '#2A1B54', surfaceActive: '#3A246B', elevated: '#281A50', elevatedForeground: '#FAF5FF',
      primary: '#E879F9', primaryForeground: '#2B0A33', secondary: '#433078', secondaryForeground: '#F3E8FF', accent: '#22D3EE', accentForeground: '#03242C', accentBackground: 'rgba(34,211,238,.15)', success: '#4ADE80', warning: '#FBBF24', danger: '#FB7185', info: '#22D3EE', agentIdle: '#B8A8D4', agentRunning: '#4ADE80', agentWaiting: '#FBBF24', agentCompleted: '#22D3EE', agentError: '#FB7185', agentPaused: '#B8A8D4',
      sessionBackground: '#1C133D', sessionForeground: '#FAF5FF', sessionBorder: '#513A7A', sessionHover: '#2A1B54', sessionSelected: '#3A246B', sessionSelectedForeground: '#F5D0FE', sessionRunning: 'rgba(74,222,128,.12)', sessionCompleted: '#1C133D', sessionError: 'rgba(251,113,133,.14)', sidebarBackground: '#0C081F', sidebarForeground: '#EDE9FE', sidebarBorder: '#513A7A', sidebarHover: '#1C133D', sidebarActive: '#3A246B', sidebarActiveForeground: '#F5D0FE', sidebarMuted: '#B8A8D4', inputBackground: '#120D2B', inputForeground: '#FAF5FF', inputBorder: '#6E4FA0', inputPlaceholder: '#B8A8D4', inputFocusBorder: '#E879F9', inputFocusRing: 'rgba(232,121,249,.24)', codeBackground: '#090617', codeForeground: '#EDE9FE', codeBorder: '#513A7A', codeMuted: '#B8A8D4', terminalBackground: '#05030D', terminalForeground: '#CFFAFE', scrollbarTrack: '#1C133D', scrollbarThumb: '#6E4FA0', scrollbarThumbHover: '#E879F9', overlayBackground: 'rgba(5,3,13,.74)', dialogBackground: '#1C133D', dialogForeground: '#FAF5FF', popoverBackground: '#1C133D', popoverForeground: '#FAF5FF', tooltipBackground: '#FAF5FF', tooltipForeground: '#120D2B',
    }, { glow: 'neon', gradientBackground: true, shadow: 'deep', motion: 'subtle' }),
    makeTheme('terminal', 'Terminal', '扁平、高密度、低装饰的命令行风格主题。', 'dark', {
      background: '#101410', foreground: '#E5F5E7', muted: '#1B241C', mutedForeground: '#8FA892', border: '#354A38', input: '#526D55', ring: '#86EFAC', surface: '#151D16', surfaceForeground: '#E5F5E7', surfaceHover: '#1F2C20', surfaceActive: '#263A28', elevated: '#1B241C', elevatedForeground: '#E5F5E7',
      primary: '#86EFAC', primaryForeground: '#0B1A0E', secondary: '#354A38', secondaryForeground: '#D1E7D4', accent: '#A7F3D0', accentForeground: '#052E1A', accentBackground: 'rgba(167,243,208,.14)', success: '#86EFAC', warning: '#FDE68A', danger: '#FDA4AF', info: '#A5F3FC', agentIdle: '#8FA892', agentRunning: '#86EFAC', agentWaiting: '#FDE68A', agentCompleted: '#A7F3D0', agentError: '#FDA4AF', agentPaused: '#8FA892',
      sessionBackground: '#151D16', sessionForeground: '#E5F5E7', sessionBorder: '#354A38', sessionHover: '#1F2C20', sessionSelected: '#263A28', sessionSelectedForeground: '#BBF7D0', sessionRunning: 'rgba(134,239,172,.12)', sessionCompleted: '#151D16', sessionError: 'rgba(253,164,175,.13)', sidebarBackground: '#0B100C', sidebarForeground: '#D1E7D4', sidebarBorder: '#354A38', sidebarHover: '#151D16', sidebarActive: '#263A28', sidebarActiveForeground: '#BBF7D0', sidebarMuted: '#8FA892', inputBackground: '#101410', inputForeground: '#E5F5E7', inputBorder: '#526D55', inputPlaceholder: '#8FA892', inputFocusBorder: '#86EFAC', inputFocusRing: 'rgba(134,239,172,.22)', codeBackground: '#080C08', codeForeground: '#D1E7D4', codeBorder: '#354A38', codeMuted: '#8FA892', terminalBackground: '#050805', terminalForeground: '#86EFAC', scrollbarTrack: '#151D16', scrollbarThumb: '#526D55', scrollbarThumbHover: '#86EFAC', overlayBackground: 'rgba(5,8,5,.75)', dialogBackground: '#151D16', dialogForeground: '#E5F5E7', popoverBackground: '#151D16', popoverForeground: '#E5F5E7', tooltipBackground: '#E5F5E7', tooltipForeground: '#101410',
    }, { glow: 'none', shadow: 'none', radiusPreset: 'compact' }),
    makeTheme('vapor', 'Vapor', '紫、粉、淡蓝组成的柔和 Vaporwave 主题。', 'light', {
      background: '#F5F0FF', foreground: '#30254A', muted: '#EEE6FA', mutedForeground: '#7D6C9D', border: '#D8C9ED', input: '#C2AEE0', ring: '#A855F7', surface: '#FFF9FF', surfaceForeground: '#30254A', surfaceHover: '#FAF2FF', surfaceActive: '#F2E8FF', elevated: '#FFFFFF', elevatedForeground: '#30254A',
      primary: '#A855F7', primaryForeground: '#FFFFFF', secondary: '#D8B4FE', secondaryForeground: '#3B1764', accent: '#EC4899', accentForeground: '#FFFFFF', accentBackground: '#FCE7F3', success: '#16A34A', warning: '#D97706', danger: '#E11D48', info: '#0891B2', agentIdle: '#A393B8', agentRunning: '#16A34A', agentWaiting: '#D97706', agentCompleted: '#0891B2', agentError: '#E11D48', agentPaused: '#A393B8',
      sessionBackground: '#FFF9FF', sessionForeground: '#30254A', sessionBorder: '#D8C9ED', sessionHover: '#FAF2FF', sessionSelected: '#F2E8FF', sessionSelectedForeground: '#7E22CE', sessionRunning: '#F0FDF4', sessionCompleted: '#FFF9FF', sessionError: '#FFF1F2', sidebarBackground: '#FDF8FF', sidebarForeground: '#493A63', sidebarBorder: '#D8C9ED', sidebarHover: '#FAF2FF', sidebarActive: '#F2E8FF', sidebarActiveForeground: '#7E22CE', sidebarMuted: '#A393B8', inputBackground: '#FFF9FF', inputForeground: '#30254A', inputBorder: '#C2AEE0', inputPlaceholder: '#A393B8', inputFocusBorder: '#A855F7', inputFocusRing: 'rgba(168,85,247,.18)', codeBackground: '#30254A', codeForeground: '#F5F0FF', codeBorder: '#59447B', codeMuted: '#B7A5D0', terminalBackground: '#211A35', terminalForeground: '#FBCFE8', scrollbarTrack: '#EEE6FA', scrollbarThumb: '#C2AEE0', scrollbarThumbHover: '#A855F7', overlayBackground: 'rgba(48,37,74,.34)', dialogBackground: '#FFF9FF', dialogForeground: '#30254A', popoverBackground: '#FFF9FF', popoverForeground: '#30254A', tooltipBackground: '#30254A', tooltipForeground: '#F5F0FF',
    }, { glow: 'soft', gradientBackground: true, shadow: 'soft', radiusPreset: 'soft' }),
  ]);

  const themeMap = new Map(builtinThemes.map((theme) => [theme.id, theme]));
  const systemThemeOption = Object.freeze({
    id: SYSTEM_THEME_ID, name: '跟随系统', description: '自动匹配操作系统当前的浅色或深色模式。', mode: true,
  });

  function validateThemeDefinition(theme) {
    if (!theme || typeof theme !== 'object' || !theme.id || !theme.name || !['light', 'dark'].includes(theme.scheme)) return false;
    if (theme.builtin !== true || !Number.isInteger(theme.version) || theme.version < 1) return false;
    if (!theme.tokens || REQUIRED_TOKENS.some((key) => typeof theme.tokens[key] !== 'string' || !theme.tokens[key])) return false;
    const effects = theme.effects || {};
    for (const [key, values] of Object.entries(EFFECT_VALUES)) if (!values.has(effects[key])) return false;
    return true;
  }

  function getTheme(id) {
    return themeMap.get(id);
  }

  function getAvailableThemes() {
    return builtinThemes.slice();
  }

  function normalizeThemeId(id) {
    const value = String(id || '').trim().toLowerCase();
    const normalized = THEME_ALIASES[value] || value;
    return normalized === SYSTEM_THEME_ID || themeMap.has(normalized) ? normalized : SYSTEM_THEME_ID;
  }

  function resolveTheme(selected, systemIsDark = false) {
    const normalized = normalizeThemeId(selected);
    return normalized === SYSTEM_THEME_ID ? (systemIsDark ? 'dark' : 'light') : normalized;
  }

  function extractSelected(input) {
    if (typeof input === 'string') return input;
    if (!input || typeof input !== 'object') return SYSTEM_THEME_ID;
    if (typeof input.selected === 'string') return input.selected;
    if (typeof input.theme === 'string') return input.theme;
    if (input.theme && typeof input.theme === 'object' && typeof input.theme.selected === 'string') return input.theme.selected;
    return SYSTEM_THEME_ID;
  }

  function migrateThemeSettings(input) {
    return { selected: normalizeThemeId(extractSelected(input)), version: THEME_SCHEMA_VERSION };
  }

  function toCssVariableName(key) {
    return '--' + String(key).replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
  }

  function effectName(theme) {
    if (theme.effects.scanlines) return 'crt';
    if (theme.effects.glow === 'neon') return 'neon';
    if (theme.effects.gradientBackground) return 'gradient';
    if (theme.id === 'ember') return 'warm';
    return 'none';
  }

  function createThemeManager(options = {}) {
    const documentRef = options.document || root.document || null;
    const storage = options.storage || (() => { try { return root.localStorage; } catch { return null; } })();
    const matchMedia = options.matchMedia || (typeof root.matchMedia === 'function' ? root.matchMedia.bind(root) : null);
    const logger = options.logger || (root.console || { warn() {} });
    const nativeAdapter = options.nativeAdapter || null;
    let selectedTheme = SYSTEM_THEME_ID;
    let resolvedTheme = 'light';
    let mediaQuery = null;
    let mediaListener = null;
    let initialized = false;
    const listeners = new Set();

    function safeGet(key) {
      try { return storage?.getItem(key); } catch { return null; }
    }
    function safeSet(key, value) {
      try { storage?.setItem(key, JSON.stringify(value)); } catch {}
    }
    function systemIsDark() {
      try { return Boolean(mediaQuery?.matches); } catch { return false; }
    }
    function getSnapshot() {
      const theme = getTheme(resolvedTheme) || getTheme('dark');
      return { selectedTheme, resolvedTheme, theme, effects: clone(theme.effects) };
    }
    function notify() {
      const snapshot = getSnapshot();
      for (const listener of listeners) {
        try { listener(snapshot); } catch (error) { logger.warn?.('[Theme] subscriber failed', error); }
      }
    }
    function applyNative(theme) {
      if (!nativeAdapter || typeof nativeAdapter.apply !== 'function') return;
      try {
        const result = nativeAdapter.apply({ scheme: theme.scheme, background: theme.tokens.background });
        if (result && typeof result.catch === 'function') result.catch((error) => logger.warn?.('[Theme] Native Adapter Failure', error));
      } catch (error) { logger.warn?.('[Theme] Native Adapter Failure', error); }
    }
    function applyTheme(shouldNotify = true) {
      resolvedTheme = resolveTheme(selectedTheme, systemIsDark());
      const theme = getTheme(resolvedTheme) || getTheme('dark');
      resolvedTheme = theme.id;
      const rootElement = documentRef?.documentElement;
      if (rootElement) {
        rootElement.dataset.theme = theme.id;
        rootElement.dataset.themeSelected = selectedTheme;
        rootElement.dataset.themeEffect = effectName(theme);
        rootElement.dataset.themeScheme = theme.scheme;
        if (rootElement.style) {
          rootElement.style.colorScheme = theme.scheme;
          for (const [key, value] of Object.entries(theme.tokens)) rootElement.style.setProperty(toCssVariableName(key), value);
          const radius = { compact: ['8px', '6px'], normal: ['12px', '8px'], soft: ['15px', '10px'] }[theme.effects.radiusPreset] || ['12px', '8px'];
          const shadow = { none: ['none', 'none'], soft: ['0 1px 2px rgba(15,23,42,.08), 0 1px 3px rgba(15,23,42,.08)', '0 8px 24px rgba(15,23,42,.14), 0 2px 6px rgba(15,23,42,.08)'], deep: ['0 2px 4px rgba(2,6,23,.18), 0 5px 16px rgba(2,6,23,.16)', '0 14px 36px rgba(2,6,23,.26), 0 4px 10px rgba(2,6,23,.16)'] }[theme.effects.shadow] || ['none', 'none'];
          rootElement.style.setProperty('--radius', radius[0]);
          rootElement.style.setProperty('--radius-sm', radius[1]);
          rootElement.style.setProperty('--shadow', shadow[0]);
          rootElement.style.setProperty('--shadow-lg', shadow[1]);
        }
      }
      applyNative(theme);
      if (shouldNotify) notify();
      return getSnapshot();
    }
    function initialize() {
      if (initialized) return getSnapshot();
      initialized = true;
      if (matchMedia) {
        try {
          mediaQuery = matchMedia('(prefers-color-scheme: dark)');
          mediaListener = () => { if (selectedTheme === SYSTEM_THEME_ID) applyTheme(true); };
          if (typeof mediaQuery.addEventListener === 'function') mediaQuery.addEventListener('change', mediaListener);
          else mediaQuery.addListener?.(mediaListener);
        } catch (error) { logger.warn?.('[Theme] System Observer Failure', error); }
      }
      const raw = safeGet(STORAGE_KEY);
      const rawSelected = raw ? extractSelected((() => { try { return JSON.parse(raw); } catch { return raw; } })()) : SYSTEM_THEME_ID;
      selectedTheme = normalizeThemeId(rawSelected);
      if (rawSelected && selectedTheme !== String(rawSelected).trim().toLowerCase() && selectedTheme === SYSTEM_THEME_ID) logger.warn?.(`[Theme] Unknown Theme: ${rawSelected}; fallback to system`);
      if (raw) safeSet(STORAGE_KEY, { selected: selectedTheme, version: THEME_SCHEMA_VERSION });
      return applyTheme(false);
    }
    function setTheme(id) {
      const requested = String(id || '').trim().toLowerCase();
      const next = normalizeThemeId(requested);
      if (next === SYSTEM_THEME_ID && requested !== SYSTEM_THEME_ID && requested !== '') logger.warn?.(`[Theme] Unknown Theme: ${id}; fallback to system`);
      selectedTheme = next;
      safeSet(STORAGE_KEY, { selected: selectedTheme, version: THEME_SCHEMA_VERSION });
      return applyTheme(true);
    }
    function subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
    function destroy() {
      if (mediaQuery && mediaListener) {
        if (typeof mediaQuery.removeEventListener === 'function') mediaQuery.removeEventListener('change', mediaListener);
        else mediaQuery.removeListener?.(mediaListener);
      }
      listeners.clear();
      initialized = false;
    }

    return {
      initialize,
      getSelectedTheme: () => selectedTheme,
      getResolvedTheme: () => resolvedTheme,
      getTheme,
      getAvailableThemes: () => [...getAvailableThemes(), systemThemeOption],
      setTheme,
      subscribe,
      destroy,
    };
  }

  root.AgentBoardTheme = {
    THEME_SCHEMA_VERSION,
    STORAGE_KEY,
    REQUIRED_TOKENS: REQUIRED_TOKENS.slice(),
    builtinThemes,
    systemThemeOption,
    getTheme,
    getAvailableThemes,
    validateThemeDefinition,
    migrateThemeSettings,
    normalizeThemeId,
    resolveTheme,
    createThemeManager,
  };
})(typeof window !== 'undefined' ? window : globalThis);
