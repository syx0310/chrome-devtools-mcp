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

  // 7. WebGL vendor/renderer spoofing — hide SwiftShader (headless fingerprint)
  const getParameterProto = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    // UNMASKED_VENDOR_WEBGL
    if (param === 0x9245) return 'Intel Inc.';
    // UNMASKED_RENDERER_WEBGL
    if (param === 0x9246) return 'Intel Iris OpenGL Engine';
    return getParameterProto.call(this, param);
  };
  const getParameterProto2 = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function (param) {
    if (param === 0x9245) return 'Intel Inc.';
    if (param === 0x9246) return 'Intel Iris OpenGL Engine';
    return getParameterProto2.call(this, param);
  };

  // 8. Fix window.outerWidth/outerHeight (0 in headless → match inner)
  if (window.outerWidth === 0) {
    Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth, configurable: true });
  }
  if (window.outerHeight === 0) {
    Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85, configurable: true });
  }

  // 9. Remove CDP artifacts — cdc_ prefixed properties (ChromeDriver/Puppeteer leak)
  const cleanCdcProps = (obj) => {
    try {
      for (const prop of Object.getOwnPropertyNames(obj)) {
        if (prop.startsWith('cdc_') || prop.startsWith('__puppeteer')) {
          try { delete obj[prop]; } catch (_e) { /* non-configurable */ }
        }
      }
    } catch (_e) { /* ignore */ }
  };
  cleanCdcProps(window);
  cleanCdcProps(document);

  // 10. DevTools open detection prevention
  // Prevent console-based DevTools detection (image trick, regex trick)
  // Some sites create an object with a custom getter and log it; the getter
  // only fires when DevTools is open and the console is rendered.
  const originalToString = Function.prototype.toString;
  // Ensure our patched functions have native-looking toString
  const patchedFns = new Set();
  const nativeToString = function toString() {
    if (patchedFns.has(this)) {
      return 'function ' + (this.name || '') + '() { [native code] }';
    }
    return originalToString.call(this);
  };
  patchedFns.add(nativeToString);
  Function.prototype.toString = nativeToString;

  // 11. navigator.maxTouchPoints — ensure non-zero when expected
  // Some detection checks for inconsistency between mobile UA and touchPoints
  // On desktop, 0 is correct; just ensure it's not flagged as automation artifact.

  // 12. Patch Error stack traces to remove puppeteer/CDP references
  const originalPrepareStackTrace = Error.prepareStackTrace;
  Error.prepareStackTrace = function (error, stack) {
    const filtered = stack.filter(frame => {
      const fn = frame.getFileName() || '';
      return !fn.includes('pptr:') && !fn.includes('__puppeteer');
    });
    if (originalPrepareStackTrace) {
      return originalPrepareStackTrace(error, filtered);
    }
    return error.name + ': ' + error.message + '\\n' + filtered.map(f => '    at ' + f.toString()).join('\\n');
  };
})();
`;

/**
 * Apply CDP-level stealth patches to a single page:
 * - Skip all debugger pauses (anti-debugging traps)
 * - Strip "HeadlessChrome" from User-Agent
 * - Remove cdc_ properties injected by CDP
 */
async function applyCdpStealth(page: Page): Promise<void> {
  try {
    // @ts-expect-error _client() is internal Puppeteer API
    const client = page._client();

    // Skip debugger; statement traps used for anti-debugging
    await client.send('Debugger.enable');
    await client.send('Debugger.setSkipAllPauses', {skip: true});

    // Strip HeadlessChrome from User-Agent
    const {userAgent: currentUA} = await client.send(
      'Browser.getVersion',
    ) as {userAgent: string};
    if (currentUA.includes('HeadlessChrome')) {
      const cleanUA = currentUA.replace(/HeadlessChrome/g, 'Chrome');
      await client.send('Network.setUserAgentOverride', {
        userAgent: cleanUA,
      });
    }

    // Remove runtime CDP artifacts (e.g. sourceURL=pptr:evaluate)
    await client.send('Runtime.evaluate', {
      expression: `
        (() => {
          for (const prop of Object.getOwnPropertyNames(window)) {
            if (prop.startsWith('cdc_') || prop.startsWith('__puppeteer')) {
              try { delete window[prop]; } catch(e) {}
            }
          }
          for (const prop of Object.getOwnPropertyNames(document)) {
            if (prop.startsWith('cdc_') || prop.startsWith('__puppeteer')) {
              try { delete document[prop]; } catch(e) {}
            }
          }
        })()
      `,
      returnByValue: true,
    });
  } catch {
    // Some targets (e.g. service workers) may not support these domains — ignore.
  }
}

/**
 * Applies the stealth init-script to a single page so that every
 * subsequent navigation automatically executes the patch before
 * any page-level JavaScript. Also applies CDP-level patches.
 */
export async function applyStealthToPage(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(STEALTH_INIT_SCRIPT);
  await applyCdpStealth(page);
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
