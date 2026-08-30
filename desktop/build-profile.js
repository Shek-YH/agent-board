'use strict';

function firstText(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || null;
}

function metadataValue(metadata, key) {
  return metadata?.[key]
    ?? metadata?.extraMetadata?.[key]
    ?? metadata?.build?.extraMetadata?.[key]
    ?? null;
}

function asBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function isLiteBuild(metadata = {}) {
  return asBoolean(metadataValue(metadata, 'agentBoardLiteMode'));
}

function resolveCloudConfig({ metadata = {}, env = process.env } = {}) {
  return {
    baseUrl: firstText(
      env.AGENT_BOARD_CLOUD_URL,
      metadataValue(metadata, 'agentBoardCloudUrl'),
    ),
    productId: firstText(
      env.AGENT_BOARD_PRODUCT_ID,
      metadataValue(metadata, 'agentBoardProductId'),
      'agent-board',
    ),
    licensePublicKey: firstText(
      env.AGENT_BOARD_LICENSE_SIGNING_PUBLIC_KEY,
      metadataValue(metadata, 'agentBoardLicenseSigningPublicKey'),
    ),
  };
}

function shouldConfigureCloud({ liteMode = false, baseUrl } = {}) {
  return !liteMode && typeof baseUrl === 'string' && Boolean(baseUrl.trim());
}

module.exports = { isLiteBuild, resolveCloudConfig, shouldConfigureCloud };
