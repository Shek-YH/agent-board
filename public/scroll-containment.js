'use strict';

// 防止嵌套滚动区到顶/到底后，滚轮继续穿透到底层瀑布流。
(function exposeScrollContainment(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScrollContainment = api;
}(globalThis, () => {
  function shouldContainWheel(element, deltaY) {
    if (!element || !Number.isFinite(deltaY) || deltaY === 0) return false;
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    if (maxScrollTop === 0) return false;
    return (deltaY < 0 && element.scrollTop <= 0) ||
      (deltaY > 0 && element.scrollTop >= maxScrollTop);
  }

  return { shouldContainWheel };
}));
