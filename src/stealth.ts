/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Browser, Page} from './third_party/index.js';

/**
 * JavaScript code injected via evaluateOnNewDocument to hide
 * automation / WebDriver detection signals.
 */
export const STEALTH_INIT_SCRIPT = `
(() => {
  // 1. navigator.webdriver → undefined
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });

  // 2. navigator.plugins — fake 5 common plugins
  const fakePlugins = [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
    { name: 'Chromium PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chromium PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
  ];

  const pluginArray = Object.create(PluginArray.prototype);
  for (let i = 0; i < fakePlugins.length; i++) {
    const p = Object.create(Plugin.prototype);
    Object.defineProperties(p, {
      name:        { value: fakePlugins[i].name,        enumerable: true },
      filename:    { value: fakePlugins[i].filename,    enumerable: true },
      description: { value: fakePlugins[i].description, enumerable: true },
      length:      { value: 0,                          enumerable: true },
    });
    pluginArray[i] = p;
  }
  Object.defineProperty(pluginArray, 'length', { value: fakePlugins.length, enumerable: true });
  Object.defineProperty(pluginArray, 'refresh', { value: () => {} });
  Object.defineProperty(pluginArray, 'item',    { value: (i) => pluginArray[i] || null });
  Object.defineProperty(pluginArray, 'namedItem', { value: (n) => {
    for (let i = 0; i < fakePlugins.length; i++) { if (pluginArray[i].name === n) return pluginArray[i]; }
    return null;
  }});

  Object.defineProperty(navigator, 'plugins', {
    get: () => pluginArray,
    configurable: true,
  });

  // 3. navigator.languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
    configurable: true,
  });

  // 4. window.chrome — fake chrome.runtime, chrome.loadTimes, chrome.csi
  if (!window.chrome) {
    Object.defineProperty(window, 'chrome', { value: {}, writable: true, configurable: true });
  }
  const chrome = window.chrome;
  if (!chrome.runtime) {
    chrome.runtime = {
      connect: () => {},
      sendMessage: () => {},
      PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
      PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
      PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
      RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
    };
  }
  if (!chrome.loadTimes) {
    chrome.loadTimes = () => ({});
  }
  if (!chrome.csi) {
    chrome.csi = () => ({});
  }

  // 5. Permissions API — query({name:'notifications'}) → 'prompt'
  const originalQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (parameters) => {
    if (parameters.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission === 'denied' ? 'prompt' : Notification.permission, onchange: null });
    }
    return originalQuery(parameters);
  };

  // 6. iframe contentWindow — hide webdriver in iframes
  const originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function () {
    return originalAttachShadow.apply(this, arguments);
  };

  const iframeContentWindowGetter = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  if (iframeContentWindowGetter) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get: function () {
        const win = iframeContentWindowGetter.get.call(this);
        if (win) {
          try {
            Object.defineProperty(win.navigator, 'webdriver', {
              get: () => undefined,
              configurable: true,
            });
          } catch (_e) {
            // cross-origin — ignore
          }
        }
        return win;
      },
      configurable: true,
    });
  }
})();
`;

/**
 * Applies the stealth init-script to a single page so that every
 * subsequent navigation automatically executes the patch before
 * any page-level JavaScript.
 */
export async function applyStealthToPage(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(STEALTH_INIT_SCRIPT);
}

/**
 * Applies stealth patches to all existing pages in the browser and
 * automatically patches any page created afterwards.
 */
export async function applyStealthToBrowser(browser: Browser): Promise<void> {
  const pages = await browser.pages();
  await Promise.all(pages.map(page => applyStealthToPage(page)));

  browser.on('targetcreated', async target => {
    try {
      const page = await target.page();
      if (page) {
        await applyStealthToPage(page);
      }
    } catch {
      // Target may have closed before we could get the page — ignore.
    }
  });
}
