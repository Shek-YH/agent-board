'use strict';

const { createPasswordResetSender } = require('./password-reset-delivery');

function buildAuthConfig(config) {
  const emailAndPassword = { enabled: true };
  const sendResetPassword = createPasswordResetSender({
    webhookUrl: config.passwordResetWebhookUrl,
    webhookSecret: config.passwordResetWebhookSecret,
  });
  if (sendResetPassword) emailAndPassword.sendResetPassword = sendResetPassword;
  return {
    secret: config.betterAuthSecret,
    baseURL: config.betterAuthUrl,
    trustedOrigins: [...config.trustedOrigins],
    emailAndPassword,
    advanced: { useSecureCookies: config.nodeEnv === 'production' },
  };
}

module.exports = { buildAuthConfig };
