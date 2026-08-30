'use strict';

const crypto = require('node:crypto');

function createPasswordResetSender({ webhookUrl, webhookSecret, fetchImpl = globalThis.fetch } = {}) {
  if (!webhookUrl || !webhookSecret) return null;
  if (typeof fetchImpl !== 'function') throw new Error('Password reset delivery requires fetch');

  return async ({ user, url: resetUrl } = {}) => {
    if (!user?.email || !resetUrl) throw new Error('Password reset delivery requires a user email and reset URL');

    const body = JSON.stringify({
      email: user.email,
      name: user.name || null,
      resetUrl,
    });
    const signature = crypto.createHmac('sha256', webhookSecret).update(body, 'utf8').digest('hex');
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-board-signature': `sha256=${signature}`,
      },
      body,
    });

    if (!response?.ok) {
      throw new Error('Password reset delivery failed');
    }
  };
}

module.exports = { createPasswordResetSender };
