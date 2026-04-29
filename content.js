// X Following Auto Pin v0.4.1 Stable Logging
// - 二重表示を防ぐため、最新選択後はページ内で「最新確認済み」として再実行しない
// - 並べ替えメニュー操作はクールダウン付きで1回ずつ実行する

(() => {
  'use strict';

  const DEFAULT_SETTINGS = {
    enableFollowingPin: true,
    enableRecentPin: true,
    enableLightLogging: false,
  };

  const CONFIG = {
    CHECK_DELAY_MS: 250,
    OBSERVER_DEBOUNCE_MS: 500,
    FOLLOWING_CLICK_COOLDOWN_MS: 2500,
    SORT_OPERATION_COOLDOWN_MS: 8000,
    MAIN_TAB_MAX_CLICK_RETRY: 3,
    MAX_SORT_RETRY_PER_PAGE: 2,
    MENU_OPEN_DELAY_MS: 220,
    CLOSE_MENU_DELAY_MS: 180,
    LOG_PREFIX: '[X Following Auto Pin]',
  };

  const TEXT = {
    following: ['Following', 'フォロー中'],
    forYou: ['For you', 'おすすめ'],
    sortButton: ['Sort', '並べ替え', '並び替え'],
    latest: ['Latest', 'Recent', '最新', '新着', '時系列'],
    popular: ['Popular', '人気'],
  };

  let settings = { ...DEFAULT_SETTINGS };
  let scheduledTimer = null;
  let lastUrl = location.href;
  let lastFollowingClickAt = 0;
  let lastSortOperationAt = 0;
  let mainTabRetryCount = 0;
  let sortRetryCount = 0;
  let observerStarted = false;
  let sortOperationInProgress = false;
  let sortVerifiedLatest = false;
  let lastLogKey = '';

  function log(key, ...args) {
    if (!settings.enableLightLogging) return;
    if (lastLogKey === key) return;
    lastLogKey = key;
    console.log(CONFIG.LOG_PREFIX, ...args);
  }

  function logAlways(...args) {
    if (settings.enableLightLogging) console.log(CONFIG.LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(CONFIG.LOG_PREFIX, ...args);
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      settings = {
        enableFollowingPin: Boolean(stored.enableFollowingPin),
        enableRecentPin: Boolean(stored.enableRecentPin),
        enableLightLogging: Boolean(stored.enableLightLogging),
      };
    } catch (error) {
      settings = { ...DEFAULT_SETTINGS };
      warn('Failed to load settings. Default settings are used.', error);
    }
  }

  function observeSettingsChanges() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') return;

      if ('enableFollowingPin' in changes) settings.enableFollowingPin = Boolean(changes.enableFollowingPin.newValue);
      if ('enableRecentPin' in changes) settings.enableRecentPin = Boolean(changes.enableRecentPin.newValue);
      if ('enableLightLogging' in changes) settings.enableLightLogging = Boolean(changes.enableLightLogging.newValue);

      resetPageState();
      scheduleCheck(CONFIG.CHECK_DELAY_MS);
      logAlways('Settings updated', settings);
    });
  }

  function resetPageState() {
    mainTabRetryCount = 0;
    sortRetryCount = 0;
    sortVerifiedLatest = false;
    sortOperationInProgress = false;
    lastLogKey = '';
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizePath(pathname) {
    return pathname.replace(/\/+$/, '') || '/';
  }

  function includesAny(value, candidates) {
    const normalized = normalizeText(value);
    return candidates.some((candidate) => normalized.includes(normalizeText(candidate)));
  }

  function getAccessibleText(element) {
    return normalizeText([
      element?.getAttribute?.('aria-label'),
      element?.getAttribute?.('title'),
      element?.textContent,
    ].filter(Boolean).join(' '));
  }

  function getStrictLabelText(element) {
    return normalizeText([
      element?.getAttribute?.('aria-label'),
      element?.getAttribute?.('title'),
    ].filter(Boolean).join(' '));
  }

  function getVisibleRect(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return rect;
  }

  function isHomeTimelineUrl(urlString = location.href) {
    const url = new URL(urlString);
    const hostOk = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname);
    if (!hostOk) return false;

    const path = normalizePath(url.pathname);
    return path === '/home' || path === '/';
  }

  function getTimelineRoot() {
    return document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main') || document.body;
  }

  function isInsideModal(element) {
    return Boolean(element?.closest?.('[role="dialog"], [aria-modal="true"]'));
  }

  function hasBlockingModal() {
    return Boolean(document.querySelector('[role="dialog"], [aria-modal="true"]'));
  }

  function isLikelyTimelineTopArea(element) {
    const rect = getVisibleRect(element);
    if (!rect) return false;
    if (isInsideModal(element)) return false;

    const topLimit = Math.min(window.innerHeight * 0.55, 520);
    const leftLimit = Math.max(0, window.innerWidth * 0.10);
    const rightLimit = Math.min(window.innerWidth, window.innerWidth * 0.90);

    return rect.top >= 0 && rect.top <= topLimit && rect.left >= leftLimit && rect.right <= rightLimit;
  }

  function isSelectedElement(element) {
    if (!element) return false;

    const ariaSelected = element.getAttribute('aria-selected');
    if (ariaSelected === 'true') return true;
    if (ariaSelected === 'false') return false;

    const ariaChecked = element.getAttribute('aria-checked');
    if (ariaChecked === 'true') return true;
    if (ariaChecked === 'false') return false;

    const ariaCurrent = element.getAttribute('aria-current');
    if (ariaCurrent === 'page' || ariaCurrent === 'true') return true;

    return false;
  }

  function findTimelineTabs() {
    const root = getTimelineRoot();
    const tabs = Array.from(root.querySelectorAll('[role="tab"]')).filter(isLikelyTimelineTopArea);

    return {
      followingTab: tabs.find((tab) => includesAny(getAccessibleText(tab), TEXT.following)),
      forYouTab: tabs.find((tab) => includesAny(getAccessibleText(tab), TEXT.forYou)),
    };
  }

  function isFollowingSelected() {
    const { followingTab } = findTimelineTabs();
    return Boolean(followingTab && isSelectedElement(followingTab));
  }

  function clickFollowingIfNeeded() {
    if (!settings.enableFollowingPin) return;
    if (!isHomeTimelineUrl()) return;
    if (hasBlockingModal()) return;

    const { followingTab, forYouTab } = findTimelineTabs();

    if (!followingTab) {
      log('following-missing', 'Following tab not found');
      return;
    }

    if (isSelectedElement(followingTab)) return;

    if (!forYouTab || !isSelectedElement(forYouTab)) {
      log('for-you-not-selected', 'For you is not selected. Skip following click.');
      return;
    }

    if (Date.now() - lastFollowingClickAt < CONFIG.FOLLOWING_CLICK_COOLDOWN_MS) return;

    if (mainTabRetryCount >= CONFIG.MAIN_TAB_MAX_CLICK_RETRY) {
      log('following-retry-limit', 'Following retry limit reached.');
      return;
    }

    mainTabRetryCount += 1;
    lastFollowingClickAt = Date.now();
    sortVerifiedLatest = false;
    logAlways('Click Following tab');
    followingTab.click();
  }

  function findSortOpener() {
    const root = getTimelineRoot();

    const explicitButtons = Array.from(root.querySelectorAll('[role="button"], button'))
      .filter(isLikelyTimelineTopArea)
      .filter((element) => !isInsideModal(element))
      .filter((element) => includesAny(getStrictLabelText(element), TEXT.sortButton));

    if (explicitButtons.length === 1) return explicitButtons[0];

    const { followingTab } = findTimelineTabs();
    if (followingTab && isSelectedElement(followingTab)) return followingTab;

    log('sort-opener-missing', 'Sort opener not found');
    return null;
  }

  function findOpenSortMenu() {
    const menuRoots = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-testid="Dropdown"]'))
      .map((element) => element.closest('[role="menu"], [role="listbox"]') || element)
      .filter((element, index, array) => array.indexOf(element) === index)
      .filter((element) => Boolean(getVisibleRect(element)))
      .filter((element) => !isInsideModal(element));

    for (const menuRoot of menuRoots) {
      const text = getAccessibleText(menuRoot);
      if (includesAny(text, TEXT.latest) && includesAny(text, TEXT.popular)) return menuRoot;
    }

    return null;
  }

  function findMenuItems(menuRoot) {
    if (!menuRoot) return { popularItem: null, latestItem: null };

    const items = Array.from(menuRoot.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]'))
      .filter((element) => Boolean(getVisibleRect(element)))
      .filter((element) => !isInsideModal(element));

    const latestItems = items.filter((element) => includesAny(getAccessibleText(element), TEXT.latest));
    const popularItems = items.filter((element) => includesAny(getAccessibleText(element), TEXT.popular));

    return {
      latestItem: latestItems.length === 1 ? latestItems[0] : null,
      popularItem: popularItems.length === 1 ? popularItems[0] : null,
    };
  }

  function hasMenuItemCheckMark(menuItem) {
    if (!menuItem) return false;
    if (isSelectedElement(menuItem)) return true;

    const text = getAccessibleText(menuItem);
    if (text.includes('✓') || text.includes('✔')) return true;

    const svg = menuItem.querySelector('svg');
    return Boolean(svg && getVisibleRect(svg) && svg.querySelector('path'));
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function clickOutsideMenu(menuRoot) {
    const rect = getVisibleRect(menuRoot);
    if (!rect) return false;

    const candidates = [
      { x: Math.max(8, Math.floor(rect.left - 24)), y: Math.max(8, Math.floor(rect.top - 24)) },
      { x: Math.min(window.innerWidth - 8, Math.floor(rect.right + 24)), y: Math.max(8, Math.floor(rect.top - 24)) },
      { x: Math.max(8, Math.floor(window.innerWidth / 2)), y: Math.max(8, Math.floor(rect.bottom + 24)) },
    ];

    const point = candidates.find(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return element && !menuRoot.contains(element);
    });

    if (!point) return false;

    const target = document.elementFromPoint(point.x, point.y) || document.body;
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: point.x,
      clientY: point.y,
      button: 0,
      buttons: 1,
    };

    target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
    target.dispatchEvent(new MouseEvent('mouseup', { ...eventOptions, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('click', { ...eventOptions, buttons: 0 }));
    logAlways('Close sort menu by outside click');
    return true;
  }

  function closeMenuSoon(menuRoot) {
    window.setTimeout(() => {
      const currentMenu = findOpenSortMenu() || menuRoot;
      clickOutsideMenu(currentMenu);
    }, CONFIG.CLOSE_MENU_DELAY_MS);
  }

  function clickLatestInMenu(menuRoot) {
    const { popularItem, latestItem } = findMenuItems(menuRoot);

    if (!popularItem || !latestItem) {
      log('sort-items-missing', 'Popular/Latest items not found uniquely');
      return false;
    }

    if (hasMenuItemCheckMark(latestItem)) {
      sortVerifiedLatest = true;
      sortRetryCount = 0;
      log('latest-already-selected', 'Latest is already selected');
      closeMenuSoon(menuRoot);
      return true;
    }

    if (!hasMenuItemCheckMark(popularItem)) {
      log('popular-not-checked', 'Popular is not checked. Skip latest click.');
      closeMenuSoon(menuRoot);
      return false;
    }

    latestItem.click();
    sortVerifiedLatest = true;
    sortRetryCount = 0;
    logAlways('Click Latest menuitem');
    closeMenuSoon(menuRoot);
    return true;
  }

  async function fixLatestSortIfNeeded() {
    if (!settings.enableRecentPin) return;
    if (!isHomeTimelineUrl()) return;
    if (hasBlockingModal()) return;
    if (!isFollowingSelected()) return;
    if (sortOperationInProgress) return;
    if (sortVerifiedLatest) return;

    if (Date.now() - lastSortOperationAt < CONFIG.SORT_OPERATION_COOLDOWN_MS) return;

    const alreadyOpenMenu = findOpenSortMenu();
    if (alreadyOpenMenu) {
      sortOperationInProgress = true;
      try {
        clickLatestInMenu(alreadyOpenMenu);
      } finally {
        window.setTimeout(() => {
          sortOperationInProgress = false;
        }, CONFIG.SORT_OPERATION_COOLDOWN_MS);
      }
      return;
    }

    if (sortRetryCount >= CONFIG.MAX_SORT_RETRY_PER_PAGE) {
      log('sort-retry-limit', 'Sort retry limit reached');
      return;
    }

    const opener = findSortOpener();
    if (!opener) return;

    sortOperationInProgress = true;
    sortRetryCount += 1;
    lastSortOperationAt = Date.now();

    try {
      logAlways('Open sort menu', { sortRetryCount });
      opener.click();
      await delay(CONFIG.MENU_OPEN_DELAY_MS);

      const menuRoot = findOpenSortMenu();
      if (!menuRoot) {
        log('sort-menu-missing-after-open', 'Sort menu not found after opener click');
        return;
      }

      clickLatestInMenu(menuRoot);
    } finally {
      window.setTimeout(() => {
        sortOperationInProgress = false;
      }, CONFIG.SORT_OPERATION_COOLDOWN_MS);
    }
  }

  function runCheck() {
    if (!isHomeTimelineUrl()) {
      resetPageState();
      return;
    }

    if (hasBlockingModal()) {
      log('modal-blocking', 'Modal detected. Actions suspended.');
      return;
    }

    clickFollowingIfNeeded();
    fixLatestSortIfNeeded();
  }

  function scheduleCheck(delayMs = CONFIG.OBSERVER_DEBOUNCE_MS) {
    if (scheduledTimer) clearTimeout(scheduledTimer);

    scheduledTimer = window.setTimeout(() => {
      scheduledTimer = null;
      runCheck();
    }, delayMs);
  }

  function handleNavigation() {
    if (lastUrl === location.href) return;

    lastUrl = location.href;
    resetPageState();
    scheduleCheck(CONFIG.CHECK_DELAY_MS);
    logAlways('Navigation detected', location.href);
  }

  function patchHistoryMethod(methodName) {
    const original = history[methodName];
    if (original.__xFollowingAutoPinPatched) return;

    const patched = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event('x-following-auto-pin:navigation'));
      return result;
    };

    patched.__xFollowingAutoPinPatched = true;
    history[methodName] = patched;
  }

  function observeSpaNavigation() {
    patchHistoryMethod('pushState');
    patchHistoryMethod('replaceState');
    window.addEventListener('popstate', handleNavigation, { passive: true });
    window.addEventListener('x-following-auto-pin:navigation', handleNavigation, { passive: true });
  }

  function observeDomChanges() {
    if (observerStarted) return;
    observerStarted = true;

    const observer = new MutationObserver(() => {
      scheduleCheck(CONFIG.OBSERVER_DEBOUNCE_MS);
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  async function start() {
    await loadSettings();
    observeSettingsChanges();
    observeSpaNavigation();
    observeDomChanges();
    scheduleCheck(CONFIG.CHECK_DELAY_MS);
    logAlways('Started v0.4.1 stable logging', settings);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
