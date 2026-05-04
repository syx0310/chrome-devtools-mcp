/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Browser, CDPSession, Page} from './third_party/index.js';
import {CDPSessionEvent} from './third_party/index.js';

const STEALTH_WORKER_INIT_SCRIPT = `
(() => {
  const globalScope = globalThis;
  const config = globalScope.__stealthWorkerConfig || {};

  const originalToString = Function.prototype.toString;
  const patchedFns = new Set();
  const nativeToString = function toString() {
    if (patchedFns.has(this)) {
      return 'function ' + (this.name || '') + '() { [native code] }';
    }
    return originalToString.call(this);
  };
  patchedFns.add(nativeToString);
  Function.prototype.toString = nativeToString;

  const defineNativeGetter = (proto, property, value) => {
    if (!proto) {
      return;
    }
    const desc = Object.getOwnPropertyDescriptor(proto, property);
    const getter = desc && desc.get;
    if (typeof getter === 'function') {
      const wrapped = new Proxy(getter, {
        apply: (target, thisArg, args) => {
          Reflect.apply(target, thisArg, args);
          return value;
        }
      });
      patchedFns.add(wrapped);
      Object.defineProperty(proto, property, {
        set: undefined,
        enumerable: desc.enumerable,
        configurable: desc.configurable,
        get: wrapped,
      });
      return;
    }
    const fallbackGetter = function () { return value; };
    patchedFns.add(fallbackGetter);
    Object.defineProperty(proto, property, {
      set: undefined,
      enumerable: true,
      configurable: true,
      get: fallbackGetter,
    });
  };

  const fallbackWebGLProfile = () => {
    const platform = typeof navigator !== 'undefined' ? navigator.platform || '' : '';
    if (/Mac|iPhone|iPad|iPod/i.test(platform)) {
      return {
        vendor: 'Google Inc. (Apple)',
        renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
      };
    }
    return {
      vendor: 'Intel Inc.',
      renderer: 'Intel Iris OpenGL Engine',
    };
  };

  const sanitizeWebGLValue = (nativeValue, nativeRenderer, key) => {
    const fallback = fallbackWebGLProfile();
    const nativeString = typeof nativeValue === 'string' ? nativeValue : '';
    const rendererString = typeof nativeRenderer === 'string' ? nativeRenderer : nativeString;
    if (!nativeString || /SwiftShader|llvmpipe|Software Rasterizer/i.test(rendererString)) {
      return fallback[key];
    }
    return nativeString;
  };

  const patchWebGLContext = proto => {
    if (!proto || typeof proto.getParameter !== 'function') {
      return;
    }
    const originalGetParameter = proto.getParameter;
    if (patchedFns.has(originalGetParameter)) {
      return;
    }
    const wrappedGetParameter = function getParameter(param) {
      if (param === 0x9245 || param === 0x9246) {
        let nativeVendor = '';
        let nativeRenderer = '';
        try {
          nativeVendor = originalGetParameter.call(this, 0x9245);
          nativeRenderer = originalGetParameter.call(this, 0x9246);
        } catch (_e) { /* ignore */ }
        if (param === 0x9245) {
          return sanitizeWebGLValue(nativeVendor, nativeRenderer, 'vendor');
        }
        return sanitizeWebGLValue(nativeRenderer, nativeRenderer, 'renderer');
      }
      return originalGetParameter.call(this, param);
    };
    patchedFns.add(wrappedGetParameter);
    proto.getParameter = wrappedGetParameter;
  };

  const patchConsole = () => {
    if (!globalScope.console) {
      return;
    }
    const originalSetTimeout = globalScope.setTimeout || (fn => fn());
    const safeCloneForConsole = (value, depth = 0, seen = new WeakSet()) => {
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        return value;
      }
      const tag = Object.prototype.toString.call(value);
      if (tag === '[object Error]' || value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
        };
      }
      if (typeof value === 'function') {
        return 'function ' + (value.name || '') + '() { [native code] }';
      }
      if (seen.has(value)) {
        return '[Circular]';
      }
      if (depth >= 3) {
        return tag;
      }
      seen.add(value);
      if (Array.isArray(value)) {
        const arr = [];
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (let i = 0; i < value.length; i++) {
          const desc = descriptors[i];
          arr[i] = desc && 'value' in desc ? safeCloneForConsole(desc.value, depth + 1, seen) : '[Getter]';
        }
        return arr;
      }
      const clone = Object.create(null);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === 'symbol') {
          continue;
        }
        const desc = descriptors[key];
        clone[key] = desc && 'value' in desc ? safeCloneForConsole(desc.value, depth + 1, seen) : '[Getter]';
      }
      return clone;
    };
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'dir', 'table', 'clear']) {
      const originalMethod = globalScope.console[method];
      if (typeof originalMethod !== 'function') {
        continue;
      }
      const wrapped = function(...args) {
        originalSetTimeout.call(globalScope, () => {
          if (method === 'clear' || args.length === 0) {
            originalMethod.apply(globalScope.console, args);
            return;
          }
          originalMethod.apply(globalScope.console, args.map(arg => safeCloneForConsole(arg)));
        }, 0);
      };
      try {
        Object.defineProperty(wrapped, 'name', { value: method, configurable: true });
      } catch (_e) { /* ignore */ }
      patchedFns.add(wrapped);
      globalScope.console[method] = wrapped;
    }
  };

  try {
    if (typeof navigator !== 'undefined') {
      const navProto = Object.getPrototypeOf(navigator);
      defineNativeGetter(navProto, 'webdriver', false);
      if (typeof config.userAgent === 'string') {
        defineNativeGetter(navProto, 'userAgent', config.userAgent);
      }
      if (typeof config.platform === 'string') {
        defineNativeGetter(navProto, 'platform', config.platform);
      }
      if (typeof config.language === 'string') {
        defineNativeGetter(navProto, 'language', config.language);
      }
      if (Array.isArray(config.languages)) {
        defineNativeGetter(navProto, 'languages', Object.freeze(config.languages.slice()));
      }
      if (typeof config.hardwareConcurrency === 'number') {
        defineNativeGetter(navProto, 'hardwareConcurrency', config.hardwareConcurrency);
      }
      if (typeof config.deviceMemory === 'number') {
        defineNativeGetter(navProto, 'deviceMemory', config.deviceMemory);
      }
    }
  } catch (_e) { /* ignore */ }

  try {
    patchWebGLContext(globalScope.WebGLRenderingContext && globalScope.WebGLRenderingContext.prototype);
    patchWebGLContext(globalScope.WebGL2RenderingContext && globalScope.WebGL2RenderingContext.prototype);
  } catch (_e) { /* ignore */ }

  patchConsole();
})();
`;

const STEALTH_WORKER_AUTO_ATTACH_SCRIPT = `
(() => {
  if (typeof WorkerGlobalScope === 'undefined' || !(globalThis instanceof WorkerGlobalScope)) {
    return;
  }
  ${STEALTH_WORKER_INIT_SCRIPT}
})();
`;

/**
 * JavaScript code injected via evaluateOnNewDocument to hide
 * automation / WebDriver detection signals.
 */
export const STEALTH_INIT_SCRIPT = `
(() => {
  // 1. navigator.webdriver -> false only when Chrome still exposes true.
  // If --disable-blink-features=AutomationControlled already makes the native
  // getter return false, keep the native descriptor untouched to avoid
  // prototype-lie detectors.
  const __wdDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
  let __shouldPatchWebdriver = false;
  try {
    __shouldPatchWebdriver = navigator.webdriver !== false;
  } catch (_e) {
    __shouldPatchWebdriver = true;
  }
  if (__shouldPatchWebdriver && __wdDesc && __wdDesc.get) {
    const __origWdGetter = __wdDesc.get;
    const __wdGetter = new Proxy(__origWdGetter, {
        apply: (target, thisArg, args) => {
          // Call original to validate 'this' binding (throws TypeError for
          // wrong type, matching native behavior)
          Reflect.apply(target, thisArg, args);
          return false;
        }
    });
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      set: undefined,
      enumerable: __wdDesc.enumerable,
      configurable: __wdDesc.configurable,
      get: __wdGetter,
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

  // 7. WebGL vendor/renderer sanitization.
  // Keep native GPU values when they are already hardware-backed. Only replace
  // obvious software renderers, so WebGL stays consistent with WebGPU and
  // worker OffscreenCanvas on Apple Silicon.
  const getFallbackWebGLProfile = () => {
    if (/Mac|iPhone|iPad|iPod/i.test(navigator.platform || '')) {
      return {
        vendor: 'Google Inc. (Apple)',
        renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
      };
    }
    return {
      vendor: 'Intel Inc.',
      renderer: 'Intel Iris OpenGL Engine',
    };
  };
  const sanitizeWebGLValue = (nativeValue, nativeRenderer, key) => {
    const fallback = getFallbackWebGLProfile();
    const nativeString = typeof nativeValue === 'string' ? nativeValue : '';
    const rendererString = typeof nativeRenderer === 'string' ? nativeRenderer : nativeString;
    if (!nativeString || /SwiftShader|llvmpipe|Software Rasterizer/i.test(rendererString)) {
      return fallback[key];
    }
    return nativeString;
  };
  const patchWebGLContext = proto => {
    if (!proto || typeof proto.getParameter !== 'function') {
      return;
    }
    const originalGetParameter = proto.getParameter;
    const wrappedGetParameter = function getParameter(param) {
      if (param === 0x9245 || param === 0x9246) {
        let nativeVendor = '';
        let nativeRenderer = '';
        try {
          nativeVendor = originalGetParameter.call(this, 0x9245);
          nativeRenderer = originalGetParameter.call(this, 0x9246);
        } catch (_e) { /* ignore */ }
        if (param === 0x9245) {
          return sanitizeWebGLValue(nativeVendor, nativeRenderer, 'vendor');
        }
        return sanitizeWebGLValue(nativeRenderer, nativeRenderer, 'renderer');
      }
      return originalGetParameter.call(this, param);
    };
    proto.getParameter = wrappedGetParameter;
  };
  patchWebGLContext(typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext.prototype : null);
  patchWebGLContext(typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext.prototype : null);

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
  try {
    if (typeof WebGLRenderingContext !== 'undefined') {
      patchedFns.add(WebGLRenderingContext.prototype.getParameter);
    }
    if (typeof WebGL2RenderingContext !== 'undefined') {
      patchedFns.add(WebGL2RenderingContext.prototype.getParameter);
    }
  } catch (_e) { /* ignore */ }

  // Patch Worker/SharedWorker constructors so detector-created Blob workers get
  // the same navigator and WebGL profile as the main realm before their code
  // executes.
  const workerStealthSource = ${JSON.stringify(STEALTH_WORKER_INIT_SCRIPT)};
  const buildWorkerConfig = () => {
    const config = {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      languages: Array.from(navigator.languages || []),
      hardwareConcurrency: navigator.hardwareConcurrency,
    };
    if (typeof navigator.deviceMemory === 'number') {
      config.deviceMemory = navigator.deviceMemory;
    }
    return config;
  };
  const makeWrappedWorkerUrl = (scriptURL, options) => {
    const rawURL = String(scriptURL);
    const absoluteURL = new URL(rawURL, location.href).href;
    const isModule = options && typeof options === 'object' && options.type === 'module';
    const bootstrap =
      'globalThis.__stealthWorkerConfig = ' + JSON.stringify(buildWorkerConfig()) + ';\\n' +
      workerStealthSource + '\\n' +
      'try { delete globalThis.__stealthWorkerConfig; } catch (_e) {}\\n';
    const source = isModule
      ? bootstrap + 'import ' + JSON.stringify(absoluteURL) + ';'
      : bootstrap + 'importScripts(' + JSON.stringify(absoluteURL) + ');';
    return URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  };
  const patchWorkerConstructor = (name) => {
    const NativeWorker = window[name];
    if (typeof NativeWorker !== 'function') {
      return;
    }
    const WrappedWorker = new Proxy(NativeWorker, {
      construct: (target, args, newTarget) => {
        let wrappedURL = null;
        try {
          if (args.length > 0) {
            const nextArgs = Array.from(args);
            wrappedURL = makeWrappedWorkerUrl(nextArgs[0], nextArgs[1]);
            nextArgs[0] = wrappedURL;
            return Reflect.construct(target, nextArgs, newTarget);
          }
        } catch (_e) {
          if (wrappedURL) {
            try { URL.revokeObjectURL(wrappedURL); } catch (_revokeError) { /* ignore */ }
          }
        }
        return Reflect.construct(target, args, newTarget);
      },
      apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args),
    });
    patchedFns.add(WrappedWorker);
    try {
      Object.defineProperty(WrappedWorker, 'name', { value: name, configurable: true });
    } catch (_e) { /* ignore */ }
    Object.defineProperty(window, name, {
      value: WrappedWorker,
      writable: true,
      configurable: true,
    });
  };
  patchWorkerConstructor('Worker');
  patchWorkerConstructor('SharedWorker');

  // 11. navigator.maxTouchPoints — ensure non-zero when expected
  // Some detection checks for inconsistency between mobile UA and touchPoints
  // On desktop, 0 is correct; just ensure it's not flagged as automation artifact.

  // 12. Patch Error stack traces to remove puppeteer/CDP references
  const sanitizeStackString = (stack) => {
    if (typeof stack !== 'string') {
      return stack;
    }
    return stack
      .split('\\n')
      .filter(line => !/pptr:|__puppeteer|puppeteer/i.test(line))
      .join('\\n');
  };

  const originalPrepareStackTrace = Error.prepareStackTrace;
  Error.prepareStackTrace = function (error, stack) {
    const filtered = stack.filter(frame => {
      const fn = frame.getFileName() || '';
      return !fn.includes('pptr:') && !fn.includes('__puppeteer');
    });
    if (originalPrepareStackTrace) {
      return originalPrepareStackTrace(error, filtered);
    }
    return sanitizeStackString(error.name + ': ' + error.message + '\\n' + filtered.map(f => '    at ' + f.toString()).join('\\n'));
  };

  const NativeError = Error;
  const sanitizeErrorInstance = (error) => {
    try {
      if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
        return error;
      }
      const stackDesc = Object.getOwnPropertyDescriptor(error, 'stack');
      if (!stackDesc) {
        return error;
      }
      if ('value' in stackDesc) {
        if (typeof stackDesc.value === 'string') {
          Object.defineProperty(error, 'stack', {
            value: sanitizeStackString(stackDesc.value),
            writable: true,
            configurable: true,
          });
        }
        return error;
      }
      if (typeof stackDesc.get === 'function') {
        const originalStackGetter = stackDesc.get;
        const sanitizedStackGetter = function stack() {
          return sanitizeStackString(originalStackGetter.call(this));
        };
        patchedFns.add(sanitizedStackGetter);
        Object.defineProperty(error, 'stack', {
          get: sanitizedStackGetter,
          set: stackDesc.set,
          enumerable: stackDesc.enumerable,
          configurable: stackDesc.configurable,
        });
      }
    } catch (_e) { /* ignore */ }
    return error;
  };

  const ErrorProxy = new Proxy(NativeError, {
    apply: (target, thisArg, args) => {
      return sanitizeErrorInstance(Reflect.apply(target, thisArg, args));
    },
    construct: (target, args, newTarget) => {
      return sanitizeErrorInstance(Reflect.construct(target, args, newTarget));
    },
  });
  patchedFns.add(ErrorProxy);
  Object.defineProperty(window, 'Error', {
    value: ErrorProxy,
    writable: true,
    configurable: true,
  });
  try { delete window.__stealthPatchedFns; } catch (_e) { /* ignore */ }
})();
`;

/**
 * Apply CDP-level stealth patches to a single page:
 * - Best-effort skip-all-pauses without enabling the Debugger domain
 * - Strip "HeadlessChrome" from User-Agent
 * - Remove cdc_ properties injected by CDP
 */
async function applyCdpStealth(page: Page): Promise<void> {
  try {
    // @ts-expect-error _client() is internal Puppeteer API
    const client = page._client();

    // Do not call Debugger.enable here. Enabling the domain from the MCP
    // session makes this session a pause target for `debugger;` statements.
    await client
      .send('Debugger.setSkipAllPauses', {skip: true})
      .catch(() => undefined);

    // Strip HeadlessChrome from User-Agent
    const {userAgent: currentUA} = (await client.send(
      'Browser.getVersion',
    )) as {userAgent: string};
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

const stealthAutoAttachBrowsers = new WeakSet<Browser>();

async function applyStealthAutoAttachToBrowser(
  browser: Browser,
): Promise<void> {
  if (stealthAutoAttachBrowsers.has(browser)) {
    return;
  }
  stealthAutoAttachBrowsers.add(browser);

  try {
    const browserSession = await browser.target().createCDPSession();

    browserSession.on(
      CDPSessionEvent.SessionAttached,
      async (childSession: CDPSession) => {
        try {
          await childSession.send('Page.addScriptToEvaluateOnNewDocument', {
            source: STEALTH_INIT_SCRIPT,
          });
        } catch {
          // Worker and service worker targets don't support the Page domain.
        }
        try {
          await childSession.send('Runtime.evaluate', {
            expression: STEALTH_WORKER_AUTO_ATTACH_SCRIPT,
            returnByValue: true,
          });
        } catch {
          // Some targets may not have an execution context yet.
        }
        try {
          await childSession.send('Runtime.runIfWaitingForDebugger');
        } catch {
          // Ignore if the target has already closed.
        }
        try {
          await childSession.detach();
        } catch {
          // If detach fails, the target may already be gone.
        }
      },
    );

    await browserSession.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  } catch {
    // Fall back to targetcreated/evaluateOnNewDocument only.
  }
}

/**
 * Applies stealth patches to all existing pages in the browser and
 * automatically patches any page created afterwards.
 */
export async function applyStealthToBrowser(browser: Browser): Promise<void> {
  await applyStealthAutoAttachToBrowser(browser);
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
  function safeCloneForConsole(value, depth = 0, seen = new WeakSet()) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return value;
    }
    const tag = Object.prototype.toString.call(value);
    if (tag === '[object Error]' || value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
      };
    }
    if (typeof value === 'function') {
      return 'function ' + (value.name || '') + '() { [native code] }';
    }
    if (seen.has(value)) {
      return '[Circular]';
    }
    if (depth >= 3) {
      return tag;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      const arr = [];
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (let i = 0; i < value.length; i++) {
        const desc = descriptors[i];
        arr[i] = desc && 'value' in desc ? safeCloneForConsole(desc.value, depth + 1, seen) : '[Getter]';
      }
      return arr;
    }

    const clone = Object.create(null);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === 'symbol') {
        continue;
      }
      const desc = descriptors[key];
      clone[key] = desc && 'value' in desc ? safeCloneForConsole(desc.value, depth + 1, seen) : '[Getter]';
    }
    return clone;
  }

  const consoleMethodsToWrap = ['log', 'info', 'warn', 'error', 'debug', 'dir', 'table', 'clear'];
  for (const method of consoleMethodsToWrap) {
    const orig = console[method].bind(console);
    const wrapped = function(...args) {
      _origSetTimeout.call(window, () => {
        if (method === 'clear' || args.length === 0) {
          orig(...args);
          return;
        }
        const safeArgs = args.map(arg => safeCloneForConsole(arg));
        orig(...safeArgs);
      }, 0);
    };
    try {
      Object.defineProperty(wrapped, 'name', { value: method, configurable: true });
    } catch (_e) { /* ignore */ }
    patchedFns.add(wrapped);
    console[method] = wrapped;
  }

  // 4. document.hasFocus() — always return true
  document.hasFocus = function hasFocus() { return true; };
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
  function safeCloneForConsole(value, depth = 0, seen = new WeakSet()) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return value;
    }
    const tag = Object.prototype.toString.call(value);
    if (tag === '[object Error]' || value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
      };
    }
    if (typeof value === 'function') {
      return 'function ' + (value.name || '') + '() { [native code] }';
    }
    if (seen.has(value)) {
      return '[Circular]';
    }
    if (depth >= 3) {
      return tag;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      const arr = [];
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (let i = 0; i < value.length; i++) {
        const desc = descriptors[i];
        arr[i] = desc && 'value' in desc ? safeCloneForConsole(desc.value, depth + 1, seen) : '[Getter]';
      }
      return arr;
    }

    const clone = Object.create(null);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === 'symbol') {
        continue;
      }
      const desc = descriptors[key];
      clone[key] = desc && 'value' in desc ? safeCloneForConsole(desc.value, depth + 1, seen) : '[Getter]';
    }
    return clone;
  }

  const consoleMethodsToWrap = ['log', 'info', 'warn', 'error', 'debug', 'dir', 'table', 'clear'];
  for (const method of consoleMethodsToWrap) {
    const orig = console[method].bind(console);
    console[method] = function(...args) {
      _origSetTimeout(() => {
        if (method === 'clear' || args.length === 0) {
          orig(...args);
          return;
        }
        const safeArgs = args.map(arg => safeCloneForConsole(arg));
        orig(...safeArgs);
      }, 0);
    };
    try {
      Object.defineProperty(console[method], 'name', { value: method, configurable: true });
    } catch (_e) { /* ignore */ }
  }

  // 4. document.hasFocus
  document.hasFocus = function hasFocus() { return true; };

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
 * - Best-effort skip-all-pauses without enabling the Debugger domain
 *   (the debuggerChecker in devtools-detector uses
 *   Function('debugger')() and measures if >100ms elapsed).
 */
async function applyCdpAntiDetection(page: Page): Promise<void> {
  try {
    // @ts-expect-error _client() is internal Puppeteer API
    const client = page._client();
    // Do not enable Debugger here; that would make MCP itself trigger pauses.
    await client
      .send('Debugger.setSkipAllPauses', {skip: true})
      .catch(() => undefined);
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
export async function applyAntiDevtoolsDetection(page: Page): Promise<void> {
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

    browserSession.on(
      CDPSessionEvent.SessionAttached,
      async (childSession: unknown) => {
        const session = childSession as {
          send: (
            method: string,
            params?: Record<string, unknown>,
          ) => Promise<unknown>;
        };
        try {
          await session.send('Page.addScriptToEvaluateOnNewDocument', {
            source: ANTI_DEVTOOLS_INIT_SCRIPT,
          });
        } catch {
          // Non-page targets (service workers, etc.) don't support Page domain.
        }
        // Do not enable Debugger here; that would make this auto-attach
        // session itself observable through `debugger;` pauses.
        await session
          .send('Debugger.setSkipAllPauses', {skip: true})
          .catch(() => undefined);
        // Resume the target — it won't start until all auto-attach sessions release.
        try {
          await session.send('Runtime.runIfWaitingForDebugger');
        } catch {
          // Ignore if the target has already closed.
        }
        try {
          if (
            childSession &&
            typeof (childSession as {detach?: unknown}).detach === 'function'
          ) {
            await (childSession as {detach: () => Promise<void>}).detach();
          }
        } catch {
          // If detach fails, the target may already be gone.
        }
      },
    );

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
