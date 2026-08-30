#!/usr/bin/env node

import {
  ALLOWED_EVENTS,
  appendProjectedEvent,
  parseHookInput,
  postProjectedEvent,
  projectEvent,
  readStdinLimited,
  resolveSpoolPath,
} from './status-runtime.mjs';

try {
  const event = process.argv[2] || '';
  if (ALLOWED_EVENTS.includes(event)) {
    const projected = projectEvent(event, parseHookInput(readStdinLimited()));
    const spoolPath = resolveSpoolPath();
    const delivered = await postProjectedEvent(projected);
    if (!delivered && spoolPath) appendProjectedEvent(spoolPath, projected);
  }
} catch {
  // 状态监控必须 fail-open，任何异常都不能阻断 WorkBuddy。
}
