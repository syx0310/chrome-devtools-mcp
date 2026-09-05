/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  fingerprintSchema,
  loadFingerprint,
  readFingerprintRevision,
  resolveFingerprintFile,
  type BrowserFingerprintFacts,
  type FingerprintProfile,
} from './fingerprint.js';
import {
  CDPSessionEvent,
  Mutex,
  zod,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Protocol,
} from './third_party/index.js';
import {logger} from './utils/logger.js';

interface StealthOptions {
  fingerprintFile?: string;
  viewport?: {width: number; height: number};
  applyToExistingPages?: boolean;
}

function hasCdpClient(page: Page): page is Page & {_client(): CDPSession} {
  return '_client' in page && typeof page._client === 'function';
}

function pageClient(page: Page): CDPSession {
  if (!hasCdpClient(page)) {
    throw new Error('Fingerprint injection requires a Chrome CDP page');
  }
  return page._client();
}

/** Preserve API shapes and native rendering; only override existing getters. */
function navigatorScript(profile?: FingerprintProfile): string {
  return `(() => {
    if (typeof navigator === 'undefined') return;
    const values = ${JSON.stringify(
      profile
        ? {
            userAgent: profile.userAgent,
            platform: profile.navigatorPlatform,
            hardwareConcurrency: profile.hardwareConcurrency,
          }
        : {},
    )};
    if ('webdriver' in navigator) values.webdriver = false;
    const proto = Object.getPrototypeOf(navigator);
    for (const [key, value] of Object.entries(values)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (!descriptor || !descriptor.get || navigator[key] === value) continue;
      Object.defineProperty(proto, key, {
        ...descriptor,
        get: new Proxy(descriptor.get, {
          apply(target, receiver, args) {
            Reflect.apply(target, receiver, args);
            return value;
          }
        })
      });
    }
  })();`;
}

export const STEALTH_INIT_SCRIPT = navigatorScript();

const navigatorFactsSchema = zod.object({
  platform: zod.string(),
  languages: zod.array(zod.string()).min(1),
  hardwareConcurrency: zod.number().int().positive(),
  windowInsets: zod.object({
    width: zod.number().nonnegative(),
    height: zod.number().nonnegative(),
  }),
  metadata: fingerprintSchema.shape.userAgentMetadata,
});

async function readBrowserFacts(
  browser: Browser,
  options: StealthOptions,
): Promise<BrowserFingerprintFacts> {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    // An intercepted HTTPS document exposes native UA Client Hints without
    // contacting a website or reading an existing user's document.
    await page.setRequestInterception(true);
    page.on('request', request => {
      void request
        .respond({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html>',
        })
        .catch(error => logger?.('Fingerprint probe request closed', error));
    });
    await page.goto('https://fingerprint.invalid/', {
      waitUntil: 'domcontentloaded',
    });
    const session = await page.createCDPSession();
    const version = await session.send('Browser.getVersion');
    const versionNumber = version.product.split('/')[1] ?? '';
    const raw: unknown = await page.evaluate(`(async () => {
      const data = navigator.userAgentData;
      const metadata = data ? await data.getHighEntropyValues([
        'architecture', 'bitness', 'platformVersion', 'fullVersionList', 'model'
      ]) : undefined;
      return {
        platform: navigator.platform,
        languages: Array.from(navigator.languages),
        hardwareConcurrency: navigator.hardwareConcurrency,
        windowInsets: {
          width: Math.max(0, outerWidth - innerWidth),
          height: Math.max(0, outerHeight - innerHeight),
        },
        metadata: metadata ? {...metadata, fullVersion: ${JSON.stringify(versionNumber)}} : undefined,
      };
    })()`);
    const facts = navigatorFactsSchema.parse(raw);
    return {
      userAgent: version.userAgent,
      version: version.product,
      navigatorPlatform: facts.platform,
      languages: facts.languages,
      hardwareConcurrency: facts.hardwareConcurrency,
      windowInsets: facts.windowInsets,
      userAgentMetadata: facts.metadata,
      viewport: options.viewport,
    };
  } finally {
    await context.close();
  }
}

function userAgentOverride(profile: FingerprintProfile) {
  return {
    userAgent: profile.userAgent,
    platform: profile.navigatorPlatform,
    acceptLanguage: profile.languages.join(','),
    userAgentMetadata: profile.userAgentMetadata,
  };
}

async function configureSession(
  session: CDPSession,
  profile: FingerprintProfile,
  type: string,
): Promise<void> {
  logger?.('Configuring fingerprint target', type);
  if (type === 'service_worker') {
    // Service-worker protocol commands wait for the worker process to start.
    // Queue all overrides before releasing startup, then await their replies.
    const commands = [
      session.send(
        'Emulation.setUserAgentOverride',
        userAgentOverride(profile),
      ),
      session.send('Emulation.setHardwareConcurrencyOverride', {
        hardwareConcurrency: profile.hardwareConcurrency,
      }),
      session.send('Runtime.evaluate', {
        expression: navigatorScript(profile),
        returnByValue: true,
      }),
    ];
    const complete = Promise.all(commands);
    void complete.catch(() => undefined);
    await session.send('Runtime.runIfWaitingForDebugger');
    await complete;
    return;
  }
  const pageTarget = type === 'page' || type === 'iframe';
  try {
    await session.send(
      'Emulation.setUserAgentOverride',
      userAgentOverride(profile),
    );
  } catch (error) {
    if (pageTarget) {
      throw error;
    }
    await session
      .send('Network.setUserAgentOverride', userAgentOverride(profile))
      .catch(error => logger?.('Worker UA override is unavailable', error));
  }
  await session
    .send('Emulation.setHardwareConcurrencyOverride', {
      hardwareConcurrency: profile.hardwareConcurrency,
    })
    .catch(error =>
      logger?.('Native hardware concurrency override is unavailable', error),
    );
  if (type === 'page') {
    const {windowId} = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: {windowState: 'normal'},
    });
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: profile.window,
    });
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: profile.viewport.width,
      height: profile.viewport.height,
      screenWidth: profile.screen.width,
      screenHeight: profile.screen.height,
      deviceScaleFactor: profile.screen.deviceScaleFactor,
      mobile: false,
    });
  }
  const source = navigatorScript(profile);
  if (pageTarget) {
    await session.send('Page.addScriptToEvaluateOnNewDocument', {source});
  } else {
    logger?.('Applying worker navigator profile', type);
    await session.send(
      'Runtime.evaluate',
      {expression: source, returnByValue: true},
      {timeout: 2000},
    );
  }
}

class FingerprintController {
  readonly browser: Browser;
  readonly filePath: string;
  readonly mutex = new Mutex();
  readonly profiles = new Map<string, FingerprintProfile>();
  readonly targets = new Map<
    string,
    {sessionId: string; profile?: FingerprintProfile; ready: Promise<void>}
  >();
  readonly targetIds = new Map<string, string>();
  readonly pages = new WeakMap<Page, Promise<void>>();
  facts?: BrowserFingerprintFacts;
  activeContext?: BrowserContext;

  constructor(browser: Browser, options: StealthOptions) {
    this.browser = browser;
    this.filePath = resolveFingerprintFile(options.fingerprintFile);
  }

  async initialize(options: StealthOptions): Promise<void> {
    this.facts = await readBrowserFacts(this.browser, options);
    if (options.applyToExistingPages !== false) {
      this.activeContext = this.browser.defaultBrowserContext();
      await this.assignContext(this.activeContext);
    }
    const session = await this.browser.target().createCDPSession();
    await this.attachChildren(session);
    if (options.applyToExistingPages !== false) {
      for (const page of await this.browser.pages()) {
        await this.applyPage(page);
      }
    }
    this.browser.once('disconnected', () => {
      this.targets.clear();
      this.targetIds.clear();
      this.profiles.clear();
    });
  }

  async assignContext(
    context: BrowserContext,
    revision?: string,
  ): Promise<void> {
    const key = context.id ?? '';
    if (this.profiles.has(key)) {
      return;
    }
    if (!this.facts) {
      throw new Error('Fingerprint controller is not initialized');
    }
    const profile = await loadFingerprint(
      this.filePath,
      this.facts,
      revision ?? (await readFingerprintRevision(this.filePath)),
    );
    this.profiles.set(key, profile);
    // Chrome can report an internal ID for its default context even though
    // Puppeteer's default BrowserContext.id is undefined.
    if (context.id === undefined) {
      const [page] = await context.pages();
      if (page) {
        const session = await page.createCDPSession();
        try {
          const {targetInfo} = await session.send('Target.getTargetInfo');
          if (targetInfo.browserContextId) {
            this.profiles.set(targetInfo.browserContextId, profile);
          }
        } finally {
          await session.detach();
        }
      }
    }
  }

  async context(requested?: BrowserContext): Promise<BrowserContext> {
    await using _guard = await this.mutex.acquire();
    if (requested) {
      await this.assignContext(requested);
      return requested;
    }
    const revision = await readFingerprintRevision(this.filePath);
    const active = this.activeContext;
    if (
      active &&
      this.browser.browserContexts().includes(active) &&
      this.profiles.get(active.id ?? '')?.revision === revision
    ) {
      return active;
    }
    const next = await this.browser.createBrowserContext();
    try {
      await this.assignContext(next, revision);
      this.activeContext = next;
      return next;
    } catch (error) {
      await next.close();
      throw error;
    }
  }

  async attachChildren(
    session: CDPSession,
    inherited?: FingerprintProfile,
  ): Promise<void> {
    session.on('Target.attachedToTarget', event => {
      const child = session.connection()?.session(event.sessionId);
      if (!child) {
        return;
      }
      const profile =
        this.profiles.get(event.targetInfo.browserContextId ?? '') ?? inherited;
      if (!profile || this.targets.has(event.targetInfo.targetId)) {
        void child
          .send('Runtime.runIfWaitingForDebugger')
          .then(() => child.detach())
          .catch(error =>
            logger?.('Additional fingerprint session closed', error),
          );
        return;
      }
      const pending = this.prepareTarget(child, event.targetInfo, profile);
      this.targets.set(event.targetInfo.targetId, {
        sessionId: child.id(),
        profile,
        ready: pending,
      });
      this.targetIds.set(child.id(), event.targetInfo.targetId);
      void pending.catch(error =>
        logger?.('Failed to configure fingerprint target', error),
      );
    });
    session.on(CDPSessionEvent.SessionDetached, child => {
      const targetId = this.targetIds.get(child.id());
      this.targetIds.delete(child.id());
      if (targetId && this.targets.get(targetId)?.sessionId === child.id()) {
        this.targets.delete(targetId);
      }
    });
    await session.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  }

  async prepareTarget(
    session: CDPSession,
    target: Protocol.Target.TargetInfo,
    profile?: FingerprintProfile,
  ): Promise<void> {
    try {
      if (profile) {
        await configureSession(session, profile, target.type);
      }
      // Auto-attach is not recursive. Retain each parent session so nested
      // workers and out-of-process iframes inherit the pinned profile.
      if (target.type !== 'service_worker') {
        await this.attachChildren(session, profile);
      }
    } finally {
      logger?.('Resuming fingerprint target', target.type);
      await session
        .send('Runtime.runIfWaitingForDebugger')
        .catch(error => logger?.('Fingerprint target already closed', error));
    }
  }

  async applyPage(page: Page): Promise<void> {
    const existing = this.pages.get(page);
    if (existing) {
      return await existing;
    }
    const profile = this.profiles.get(page.browserContext().id ?? '');
    if (!profile) {
      return;
    }
    const pending = (async () => {
      // Reuse Puppeteer's page session. Concurrent createCDPSession calls from
      // McpPage initialization can misclassify manual sessions in Puppeteer.
      const session = pageClient(page);
      const {targetInfo} = await session.send('Target.getTargetInfo');
      const automatic = this.targets.get(targetInfo.targetId);
      if (automatic?.profile?.id === profile.id) {
        await automatic.ready;
      } else {
        await configureSession(session, profile, 'page');
      }
    })();
    this.pages.set(page, pending);
    try {
      await pending;
    } catch (error) {
      this.pages.delete(page);
      throw error;
    }
  }
}

const controllers = new WeakMap<Browser, FingerprintController>();

export async function applyStealthToBrowser(
  browser: Browser,
  options: StealthOptions = {},
): Promise<void> {
  if (controllers.has(browser)) {
    return;
  }
  const controller = new FingerprintController(browser, options);
  try {
    await controller.initialize(options);
    controllers.set(browser, controller);
  } catch (error) {
    throw new Error(
      'Could not initialize the Apify fingerprint. Update fingerprint-generator or use --no-stealth.',
      {cause: error},
    );
  }
}

export async function prepareFingerprintContext(
  browser: Browser,
  requested?: BrowserContext,
): Promise<BrowserContext> {
  return (
    (await controllers.get(browser)?.context(requested)) ??
    requested ??
    browser.defaultBrowserContext()
  );
}

export async function applyStealthToPage(page: Page): Promise<void> {
  const controller = controllers.get(page.browser());
  if (controller) {
    await controller.applyPage(page);
    return;
  }
  await page.evaluateOnNewDocument(STEALTH_INIT_SCRIPT);
}

/** Keep debugger statements from pausing MCP without rewriting page APIs. */
export async function applyAntiDevtoolsDetection(page: Page): Promise<void> {
  await pageClient(page).send('Debugger.setSkipAllPauses', {skip: true});
}

export async function applyAntiDevtoolsDetectionToBrowser(
  browser: Browser,
): Promise<void> {
  for (const page of await browser.pages()) {
    await applyAntiDevtoolsDetection(page);
  }
}
