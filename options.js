(() => {
  'use strict';

  const DEFAULT_SETTINGS = {
    enableFollowingPin: true,
    enableRecentPin: true,
    enableLightLogging: false,
    uiLanguage: 'auto',
  };

  const MESSAGES = {
    ja: {
      title: 'X Following Auto Pin',
      description: 'XのホームタイムラインをFollowingと最新表示に固定します。',
      languageLabel: '表示言語',
      followingTitle: 'Following固定を有効にする',
      followingHelp: 'For you / おすすめ が選択中の場合、Following / フォロー中 に戻します。',
      recentTitle: '最新 / 時系列固定を有効にする',
      recentHelp: '人気が選択されている場合だけ、1回だけメニューを開いて最新 / Latest に戻します。',
      loggingTitle: '軽量ログを有効にする',
      loggingHelp: '動作確認用にConsoleへ最小限のログを出します。通常はOFF推奨です。',
      saved: '保存しました',
    },
    en: {
      title: 'X Following Auto Pin',
      description: 'Keeps the X home timeline on Following and Latest.',
      languageLabel: 'Language',
      followingTitle: 'Enable Following pin',
      followingHelp: 'When For you is selected, switch back to Following.',
      recentTitle: 'Enable Latest / chronological pin',
      recentHelp: 'When Popular is selected, open the sort menu once and switch back to Latest.',
      loggingTitle: 'Enable light logging',
      loggingHelp: 'Writes minimal diagnostic logs to the Console. Usually recommended OFF.',
      saved: 'Saved',
    },
  };

  const followingCheckbox = document.getElementById('enableFollowingPin');
  const recentCheckbox = document.getElementById('enableRecentPin');
  const loggingCheckbox = document.getElementById('enableLightLogging');
  const languageSelect = document.getElementById('languageSelect');
  const statusText = document.getElementById('statusText');

  let currentLanguage = resolveBrowserLanguage();

  function resolveBrowserLanguage() {
    const language = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
    return language.startsWith('ja') ? 'ja' : 'en';
  }

  function resolveLanguage(selected) {
    if (selected === 'ja' || selected === 'en') return selected;
    return resolveBrowserLanguage();
  }

  function applyLanguage(language) {
    currentLanguage = language;
    document.documentElement.lang = language;

    const dict = MESSAGES[language] || MESSAGES.en;
    document.querySelectorAll('[data-i18n]').forEach((element) => {
      const key = element.getAttribute('data-i18n');
      if (dict[key]) element.textContent = dict[key];
    });
  }

  function setStatus(messageKey) {
    const dict = MESSAGES[currentLanguage] || MESSAGES.en;
    const message = dict[messageKey] || messageKey;
    statusText.textContent = message;

    window.setTimeout(() => {
      if (statusText.textContent === message) statusText.textContent = '';
    }, 1600);
  }

  async function loadOptions() {
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

    followingCheckbox.checked = Boolean(settings.enableFollowingPin);
    recentCheckbox.checked = Boolean(settings.enableRecentPin);
    loggingCheckbox.checked = Boolean(settings.enableLightLogging);

    const selectedLanguage = settings.uiLanguage || DEFAULT_SETTINGS.uiLanguage;
    languageSelect.value = selectedLanguage;
    applyLanguage(resolveLanguage(selectedLanguage));
  }

  async function saveOptions() {
    await chrome.storage.sync.set({
      enableFollowingPin: followingCheckbox.checked,
      enableRecentPin: recentCheckbox.checked,
      enableLightLogging: loggingCheckbox.checked,
      uiLanguage: languageSelect.value,
    });

    applyLanguage(resolveLanguage(languageSelect.value));
    setStatus('saved');
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await loadOptions();

    followingCheckbox.addEventListener('change', saveOptions);
    recentCheckbox.addEventListener('change', saveOptions);
    loggingCheckbox.addEventListener('change', saveOptions);
    languageSelect.addEventListener('change', saveOptions);
  });
})();
