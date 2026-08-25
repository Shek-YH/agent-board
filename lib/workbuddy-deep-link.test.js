'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildWorkBuddyDeepLink,
  isValidWorkBuddySessionId,
} = require('./workbuddy-deep-link');

test('构造 WorkBuddy 对应会话的桌面端深链', () => {
  assert.equal(
    buildWorkBuddyDeepLink('18d4fc59-323e-40a3-8c78-efcbef13931c'),
    'workbuddy://chat/18d4fc59-323e-40a3-8c78-efcbef13931c',
  );
});

test('WorkBuddy sessionId 只接受 UUID，避免注入其他 URL 或路径', () => {
  assert.equal(isValidWorkBuddySessionId('18d4fc59-323e-40a3-8c78-efcbef13931c'), true);
  assert.equal(isValidWorkBuddySessionId('18d4fc59-323e-40a3-8c78-efcbef13931c/other'), false);
  assert.equal(isValidWorkBuddySessionId('javascript:alert(1)'), false);
  assert.throws(() => buildWorkBuddyDeepLink('../settings'), /sessionId/);
});
