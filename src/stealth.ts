/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Browser, Page} from './third_party/index.js';
import {CDPSessionEvent} from './third_party/index.js';

/**
 * JavaScript code injected via evaluateOnNewDocument to hide
 * automation / WebDriver detection signals.
 */
export const STEALTH_INIT_SCRIPT = `
(() => {
  // 1. navigator.webdriver → false (like real non-automated Chrome)
  // Must patch Navigator.prototype (not navigator instance) because
  // anti-detection checks can bypass instance-level patches via:
  //   Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver').get.apply(navigator)
  const __wdDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
  if (__wdDesc && __wdDesc.get) {
    const __origWdGetter = __wdDesc.get;
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      set: undefined,
      enumerable: true,
      configurable: true,
      get: new Proxy(__origWdGetter, {
        apply: (target, thisArg, args) => {
          // Call original to validate 'this' binding (throws TypeError for
          // wrong type, matching native behavior)
          Reflect.apply(target, thisArg, args);
          return false;
        }
      })
    });
  }

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

  // Patch Navigator.prototype.plugins (not navigator instance) to avoid
  // Object.getOwnPropertyNames(navigator) revealing own-property overrides.
  const __pluginsDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins');
  if (__pluginsDesc && __pluginsDesc.get) {
    const __origPluginsGetter = __pluginsDesc.get;
    Object.defineProperty(Navigator.prototype, 'plugins', {
      set: undefined,
      enumerable: true,
      configurable: true,
      get: new Proxy(__origPluginsGetter, {
        apply: (target, thisArg, args) => {
          Reflect.apply(target, thisArg, args);
          return pluginArray;
        }
      })
    });
  }

  // 3. navigator.languages — patch on prototype
  const __langsDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages');
  if (__langsDesc && __langsDesc.get) {
    const __origLangsGetter = __langsDesc.get;
    Object.defineProperty(Navigator.prototype, 'languages', {
      set: undefined,
      enumerable: true,
      configurable: true,
      get: new Proxy(__origLangsGetter, {
        apply: (target, thisArg, args) => {
          Reflect.apply(target, thisArg, args);
          return Object.freeze(['en-US', 'en']);
        }
      })
    });
  }

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
            // Patch Navigator.prototype in the iframe's own realm
            const iframeNavProto = win.Navigator?.prototype || Object.getPrototypeOf(win.navigator);
            const iframeWdDesc = Object.getOwnPropertyDescriptor(iframeNavProto, 'webdriver');
            if (iframeWdDesc && iframeWdDesc.get) {
              const iframeOrigGetter = iframeWdDesc.get;
              Object.defineProperty(iframeNavProto, 'webdriver', {
                set: undefined,
                enumerable: true,
                configurable: true,
                get: new Proxy(iframeOrigGetter, {
                  apply: (target, thisArg, args) => {
                    Reflect.apply(target, thisArg, args);
                    return false;
                  }
                })
              });
            }
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
  // Share patchedFns across stealth and anti-devtools-detection scripts
  const patchedFns = window.__stealthPatchedFns || new Set();
  window.__stealthPatchedFns = patchedFns;
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

/**
 * JavaScript code injected via evaluateOnNewDocument to block
 * DevTools detection scripts. This is a separate script from
 * STEALTH_INIT_SCRIPT and can be enabled/disabled independently.
 */
export const ANTI_DEVTOOLS_INIT_SCRIPT = `
(() => {
  // 0. Function.prototype.toString patching — share patchedFns with stealth script
  const originalToString = Function.prototype.toString;
  const patchedFns = window.__stealthPatchedFns || new Set();
  if (!window.__stealthPatchedFns) {
    // Stealth script not loaded — set up toString patching ourselves
    const nativeToString = function toString() {
      if (patchedFns.has(this)) {
        return 'function ' + (this.name || '') + '() { [native code] }';
      }
      return originalToString.call(this);
    };
    patchedFns.add(nativeToString);
    Function.prototype.toString = nativeToString;
  }
  // Clean up the shared reference from window
  try { delete window.__stealthPatchedFns; } catch (_e) { /* ignore */ }

  // 0.5 Reduce performance.now() precision to defeat timing-based detection.
  // performanceChecker measures console.table vs console.log with microsecond
  // precision. Rounding to 1ms makes both measurements return 0, so the
  // checker's "tablePrintTime === 0" guard triggers and returns false.
  const origPerfNow = performance.now.bind(performance);
  performance.now = function now() {
    return Math.round(origPerfNow());
  };
  patchedFns.add(performance.now);

  // 1. Timer interception — detect and suppress DevTools detection polling
  // Match known detection patterns in timer callbacks:
  // - devtool/devtools keywords
  // - debugger statement (including minified: debugger} debugger;)
  // - window dimension comparisons
  // - console timing patterns
  // - constructor('debugger') pattern used by devtools-detector
  const DETECT_RE = /devtool|\\bdebugger\\b|outerWidth|outerHeight|innerWidth.{0,20}innerHeight|constructor\\s*\\(\\s*['"]debugger/i;

  const _origSetInterval = window.setInterval;
  const _origSetTimeout = window.setTimeout;

  function isDetectionCallback(fn) {
    if (typeof fn === 'function') {
      try {
        const src = originalToString.call(fn);
        return DETECT_RE.test(src);
      } catch (_e) { return false; }
    }
    if (typeof fn === 'string') {
      return DETECT_RE.test(fn);
    }
    return false;
  }

  window.setInterval = function(fn, delay, ...args) {
    if (isDetectionCallback(fn)) {
      return _origSetInterval(() => {}, delay);
    }
    return _origSetInterval.call(this, fn, delay, ...args);
  };
  window.setTimeout = function(fn, delay, ...args) {
    if (isDetectionCallback(fn)) {
      return _origSetTimeout(() => {}, delay);
    }
    return _origSetTimeout.call(this, fn, delay, ...args);
  };
  patchedFns.add(window.setInterval);
  patchedFns.add(window.setTimeout);

  // 2. Window dimension consistency — always report values without DevTools docked
  const CHROME_VERTICAL = 85; // typical title bar + toolbar height
  Object.defineProperty(window, 'outerWidth', {
    get: () => window.innerWidth,
    configurable: true,
  });
  Object.defineProperty(window, 'outerHeight', {
    get: () => window.innerHeight + CHROME_VERTICAL,
    configurable: true,
  });

  // 3. Console detection prevention
  // Performance detection: devtools-detector measures console.table/log timing
  // with large objects — rendering is slow when DevTools console is open.
  // toString/getter detection: logs objects with custom toString/getters that
  // fire only when DevTools renders the console output.
  // Fix: defer actual console output to next task via setTimeout(0) so timing
  // measurement returns ~0ms, and sanitize arguments to strip getters/toString.
  const consoleMethodsToWrap = ['log', 'info', 'warn', 'error', 'debug', 'dir', 'table', 'clear'];
  for (const method of consoleMethodsToWrap) {
    const orig = console[method].bind(console);
    const wrapped = function(...args) {
      _origSetTimeout.call(window, () => {
        if (method === 'clear' || args.length === 0) {
          orig(...args);
          return;
        }
        const safeArgs = args.map(arg => {
          if (typeof arg === 'function') {
            return String(arg);
          }
          if (arg !== null && typeof arg === 'object') {
            try { return JSON.parse(JSON.stringify(arg)); }
            catch (_e) {
              try { return structuredClone(arg); }
              catch (_e2) { return String(arg); }
            }
          }
          return arg;
        });
        orig(...safeArgs);
      }, 0);
    };
    patchedFns.add(wrapped);
    console[method] = wrapped;
  }

  // 4. document.hasFocus() — always return true
  document.hasFocus = function() { return true; };
  patchedFns.add(document.hasFocus);

  // 5. Notification.permission — fix 'denied' in automated mode
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      Object.defineProperty(Notification, 'permission', {
        get: () => 'default',
        configurable: true,
      });
    }
  } catch (_e) { /* ignore */ }

  // 6. Block devtoolsFormatters detection.
  // devtoolsFormatterChecker registers a custom formatter whose header()
  // fires when DevTools renders console output. Returning a fresh empty
  // array from the getter ensures pushed formatters are immediately discarded.
  Object.defineProperty(window, 'devtoolsFormatters', {
    get: () => [],
    set: () => {},
    configurable: true,
  });
})();
`;

/**
 * Script to apply anti-DevTools-detection patches immediately to an
 * already-loaded document. Unlike evaluateOnNewDocument (which runs
 * before page scripts on future navigations), this runs in the current
 * context where detection scripts may already be active. It clears
 * existing detection timers and re-applies protections.
 */
const ANTI_DEVTOOLS_IMMEDIATE_SCRIPT = `
(() => {
  // 1. Clear all existing timers to stop any running detection polling.
  // This is the same approach as the Tampermonkey anti-detection script.
  const maxId = setTimeout(() => {}, 0);
  for (let i = 1; i <= maxId; i++) {
    clearTimeout(i);
    clearInterval(i);
  }

  // 2. Apply dimension overrides (works even on already-loaded pages)
  Object.defineProperty(window, 'outerWidth', {
    get: () => window.innerWidth,
    configurable: true,
  });
  Object.defineProperty(window, 'outerHeight', {
    get: () => window.innerHeight + 85,
    configurable: true,
  });

  // 3. Override console methods (detection scripts may have cached
  // the originals, but overriding the console object properties still
  // helps for any new detection code and for sites that read console
  // methods lazily rather than caching them at init time).
  const _origSetTimeout = setTimeout;
  const consoleMethodsToWrap = ['log', 'info', 'warn', 'error', 'debug', 'dir', 'table', 'clear'];
  for (const method of consoleMethodsToWrap) {
    const orig = console[method].bind(console);
    console[method] = function(...args) {
      _origSetTimeout(() => {
        if (method === 'clear' || args.length === 0) {
          orig(...args);
          return;
        }
        const safeArgs = args.map(arg => {
          if (typeof arg === 'function') {
            return String(arg);
          }
          if (arg !== null && typeof arg === 'object') {
            try { return JSON.parse(JSON.stringify(arg)); }
            catch { try { return structuredClone(arg); } catch { return String(arg); } }
          }
          return arg;
        });
        orig(...safeArgs);
      }, 0);
    };
  }

  // 4. document.hasFocus
  document.hasFocus = function() { return true; };

  // 5. Reduce performance.now() precision
  const origPerfNow = performance.now.bind(performance);
  performance.now = function() {
    return Math.round(origPerfNow());
  };

  // 6. Block devtoolsFormatters
  try {
    Object.defineProperty(window, 'devtoolsFormatters', {
      get: () => [],
      set: () => {},
      configurable: true,
    });
  } catch (_e) { /* ignore */ }
})();
`;

/**
 * Apply CDP-level anti-detection patches:
 * - Skip all debugger pauses to defeat debugger-timing detection
 *   (the debuggerChecker in devtools-detector uses
 *   Function('debugger')() and measures if >100ms elapsed).
 */
async function applyCdpAntiDetection(page: Page): Promise<void> {
  try {
    // @ts-expect-error _client() is internal Puppeteer API
    const client = page._client();
    await client.send('Debugger.enable');
    await client.send('Debugger.setSkipAllPauses', {skip: true});
  } catch {
    // Some targets (e.g. service workers) may not support Debugger domain.
  }
}

/**
 * Applies anti-DevTools-detection patches to a single page so that
 * every subsequent navigation automatically executes the patch before
 * any page-level JavaScript. Also applies patches immediately to the
 * current document to handle pages that are already loaded.
 */
export async function applyAntiDevtoolsDetection(
  page: Page,
): Promise<void> {
  // Register for all future navigations (runs before page scripts)
  await page.evaluateOnNewDocument(ANTI_DEVTOOLS_INIT_SCRIPT);
  // CDP-level patches (debugger skip)
  await applyCdpAntiDetection(page);
  // Also apply immediately to the current document (clears existing
  // detection timers and re-applies protections in case the page has
  // already loaded with detection scripts running).
  try {
    await page.evaluate(ANTI_DEVTOOLS_IMMEDIATE_SCRIPT);
  } catch {
    // Page may not be ready (e.g. about:blank with no execution context) — ignore.
  }
}

/**
 * Applies anti-DevTools-detection patches to all existing pages in
 * the browser and automatically patches any page created afterwards.
 *
 * Uses CDP-level auto-attach with waitForDebuggerOnStart to intercept
 * new pages BEFORE they start executing JavaScript. This prevents the
 * race condition where detection scripts run before our patches are
 * applied (e.g. pages opened via window.open or target="_blank").
 */
export async function applyAntiDevtoolsDetectionToBrowser(
  browser: Browser,
): Promise<void> {
  const pages = await browser.pages();
  await Promise.all(pages.map(page => applyAntiDevtoolsDetection(page)));

  // Set up CDP-level auto-attach on a separate browser session.
  // When a new target is created, Chrome pauses it (waitForDebuggerOnStart)
  // until we inject our scripts and call Runtime.runIfWaitingForDebugger.
  // This runs independently of Puppeteer's own auto-attach — the target
  // waits for ALL sessions to release before executing.
  try {
    const browserSession = await browser.target().createCDPSession();

    browserSession.on(CDPSessionEvent.SessionAttached, async (childSession: unknown) => {
      const session = childSession as {send: (method: string, params?: Record<string, unknown>) => Promise<unknown>};
      try {
        await session.send('Page.addScriptToEvaluateOnNewDocument', {
          source: ANTI_DEVTOOLS_INIT_SCRIPT,
        });
      } catch {
        // Non-page targets (service workers, etc.) don't support Page domain.
      }
      try {
        await session.send('Debugger.enable');
        await session.send('Debugger.setSkipAllPauses', {skip: true});
      } catch {
        // Some targets may not support Debugger domain.
      }
      // Resume the target — it won't start until all auto-attach sessions release.
      try {
        await session.send('Runtime.runIfWaitingForDebugger');
      } catch {
        // Ignore if the target has already closed.
      }
    });

    await browserSession.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  } catch {
    // If CDP auto-attach setup fails, fall back to targetcreated only.
  }

  // Keep targetcreated handler as a complement: it applies evaluateOnNewDocument
  // for future navigations within the page and runs the immediate script on the
  // current document.
  browser.on('targetcreated', async target => {
    try {
      const page = await target.page();
      if (page) {
        await applyAntiDevtoolsDetection(page);
      }
    } catch {
      // Target may have closed before we could get the page — ignore.
    }
  });
}
