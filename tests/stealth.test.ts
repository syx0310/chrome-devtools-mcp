/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {setTimeout} from 'node:timers/promises';

import {executablePath} from 'puppeteer';

import {launch} from '../src/browser.js';
import {resetFingerprint} from '../src/fingerprint.js';
import {
  applyAntiDevtoolsDetection,
  applyStealthToPage,
  prepareFingerprintContext,
} from '../src/stealth.js';
import {zod, type Browser, type Page} from '../src/third_party/index.js';

import {serverHooks} from './server.js';

const identitySchema = zod.object({
  userAgent: zod.string(),
  platform: zod.string(),
  cpus: zod.number(),
  languages: zod.array(zod.string()),
  brands: zod.array(zod.object({brand: zod.string(), version: zod.string()})),
  hasWebdriver: zod.boolean(),
});
const identitySource = `({
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  cpus: navigator.hardwareConcurrency,
  languages: Array.from(navigator.languages),
  brands: navigator.userAgentData?.brands ?? [],
  hasWebdriver: 'webdriver' in navigator,
})`;

async function identity(page: Page) {
  const raw: unknown = await page.evaluate(identitySource);
  return identitySchema.parse(raw);
}

describe('stealth browser contracts', () => {
  const server = serverHooks();
  let browser: Browser;
  let directory: string;
  let fingerprintFile: string;

  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stealth-contract-'));
    fingerprintFile = path.join(directory, 'fingerprint.json');
    browser = await launch({
      headless: true,
      isolated: true,
      executablePath: await executablePath(),
      devtools: false,
      stealth: true,
      fingerprintFile,
    });
  });
  after(async () => {
    await browser?.close();
    await fs.rm(directory, {recursive: true, force: true});
  });

  async function page() {
    const context = await prepareFingerprintContext(browser);
    const created = await context.newPage();
    await applyStealthToPage(created);
    server.addHtmlRoute(
      '/page',
      '<!doctype html><body>Fingerprint test</body>',
    );
    server.addRoute('/headers', (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.headers));
    });
    await created.goto(server.getRoute('/page'));
    return created;
  }

  it('sets matching UA Client Hints without replacing native browser APIs', async () => {
    const p = await page();
    const data = await identity(p);
    assert.doesNotMatch(data.userAgent, /HeadlessChrome/);
    assert.ok(data.brands.some(brand => brand.brand === 'Chromium'));
    const rawHeaders: unknown = await p.evaluate(() =>
      fetch('/headers').then(response => response.json()),
    );
    const headers = zod.record(zod.string(), zod.string()).parse(rawHeaders);
    assert.equal(headers['user-agent'], data.userAgent);
    assert.ok(headers['sec-ch-ua']);
    assert.ok(headers['sec-ch-ua-platform']);
    const surfaces = await p.evaluate(async () => {
      const permission = await navigator.permissions.query({
        name: 'notifications',
      });
      const gl = document.createElement('canvas').getContext('webgl');
      const invalidRenderer = gl?.getParameter(0x9246);
      return {
        webdriver: navigator.webdriver,
        validPermission: permission instanceof PermissionStatus,
        permission: permission.state,
        pluginsLinked: Array.from(navigator.mimeTypes).every(mime =>
          Array.from(navigator.plugins).includes(mime.enabledPlugin),
        ),
        toStringHasPrototype: Object.hasOwn(
          Function.prototype.toString,
          'prototype',
        ),
        errorConstructor: new Error().constructor === Error,
        invalidRenderer,
        outer: {width: outerWidth, height: outerHeight},
        inner: {width: innerWidth, height: innerHeight},
        screen: {width: screen.width, height: screen.height},
      };
    });
    assert.equal(surfaces.webdriver, false);
    assert.equal(surfaces.validPermission, true);
    assert.equal(surfaces.permission, 'prompt');
    assert.equal(surfaces.pluginsLinked, true);
    assert.equal(surfaces.toStringHasPrototype, false);
    assert.equal(surfaces.errorConstructor, true);
    assert.equal(surfaces.invalidRenderer, null);
    assert.ok(surfaces.outer.width >= surfaces.inner.width);
    assert.ok(surfaces.outer.height >= surfaces.inner.height);
    assert.ok(surfaces.screen.width >= surfaces.outer.width);
    assert.ok(surfaces.screen.height >= surfaces.outer.height);
  });

  for (const type of ['classic', 'module']) {
    it(`configures ${type} workers before their first statement and preserves relative URLs`, async () => {
      const p = await page();
      server.addRoute('/worker.js', (_request, response) => {
        response.setHeader('Content-Type', 'application/javascript');
        response.end(
          `const first = ${identitySource}; fetch('./headers').then(() => postMessage({...first, location:location.href}));`,
        );
      });
      const raw: unknown = await p.evaluate(`new Promise((resolve, reject) => {
        const w = new Worker('/worker.js', {type:${JSON.stringify(type)}});
        const timer = setTimeout(() => {w.terminate();reject(new Error('Worker timed out'));}, 5000);
        w.onmessage = e => {clearTimeout(timer);w.terminate();resolve(e.data);};
        w.onerror = e => {clearTimeout(timer);w.terminate();reject(new Error(e.message));};
      })`);
      const worker = identitySchema.extend({location: zod.string()}).parse(raw);
      const main = await identity(p);
      assert.equal(worker.userAgent, main.userAgent);
      assert.equal(worker.cpus, main.cpus);
      assert.deepEqual(worker.brands, main.brands);
      assert.deepEqual(worker.languages, main.languages);
      assert.equal(worker.hasWebdriver, false);
      assert.equal(worker.location, server.getRoute('/worker.js'));
    });
  }

  it('retains SharedWorker reuse and supports worker-src self', async () => {
    const p = await page();
    server.addRoute('/csp', (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.setHeader('Content-Security-Policy', "worker-src 'self'");
      response.end('<!doctype html>');
    });
    server.addRoute('/shared.js', (_request, response) => {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(
        'let count=0; onconnect=e=>e.ports[0].postMessage(++count);',
      );
    });
    await p.goto(server.getRoute('/csp'));
    const counts = await p.evaluate(`(async () => {
      const workers = [];
      const connect = () => new Promise((resolve, reject) => {
        const w = new SharedWorker('/shared.js', {name:'reuse'});
        workers.push(w);
        const timer = setTimeout(() => reject(new Error('SharedWorker timed out')), 5000);
        w.port.onmessage = e => {clearTimeout(timer);resolve(e.data);};
        w.onerror = e => {clearTimeout(timer);reject(new Error(e.message));};
      });
      const counts = [await connect(), await connect()];
      for (const w of workers) w.port.close();
      return counts;
    })()`);
    assert.deepEqual(counts, [1, 2]);
  });

  it('keeps nested workers and service workers on the page profile', async () => {
    const p = await page();
    server.addRoute('/leaf.js', (_request, response) => {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(`postMessage(${identitySource});`);
    });
    server.addRoute('/nested.js', (_request, response) => {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(
        "const child = new Worker('./leaf.js'); child.onmessage = e => {postMessage(e.data);child.terminate();};",
      );
    });
    server.addRoute('/service.js', (_request, response) => {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(
        `const first = ${identitySource}; oninstall = () => skipWaiting(); onactivate = e => e.waitUntil(clients.claim()); onmessage = e => e.ports[0].postMessage(first);`,
      );
    });
    const raw: unknown = await p.evaluate(`(async () => {
      const nested = await new Promise((resolve, reject) => {
        const w = new Worker('/nested.js');
        const timer = setTimeout(() => {w.terminate();reject(new Error('Nested worker timed out'));}, 5000);
        w.onmessage = e => {clearTimeout(timer);w.terminate();resolve(e.data);};
        w.onerror = e => {clearTimeout(timer);w.terminate();reject(new Error(e.message));};
      });
      const bounded = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), 10000))]);
      const registration = await bounded(navigator.serviceWorker.register('/service.js'), 'Service registration');
      await bounded(navigator.serviceWorker.ready, 'Service activation');
      const service = await new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => reject(new Error('Service worker timed out')), 5000);
        channel.port1.onmessage = e => {clearTimeout(timer);channel.port1.close();resolve(e.data);};
        registration.active.postMessage('read', [channel.port2]);
      });
      await registration.unregister();
      return {nested, service};
    })()`);
    const workers = zod
      .object({nested: identitySchema, service: identitySchema})
      .parse(raw);
    const main = await identity(p);
    for (const worker of [workers.nested, workers.service]) {
      assert.equal(worker.userAgent, main.userAgent);
      assert.equal(worker.cpus, main.cpus);
      assert.deepEqual(worker.brands, main.brands);
      assert.equal(worker.hasWebdriver, false);
    }
  });

  it('keeps cross-origin frame navigator values consistent', async () => {
    const p = await page();
    server.addHtmlRoute('/frame', '<!doctype html>');
    const frameUrl = server
      .getRoute('/frame')
      .replace('127.0.0.1', 'localhost');
    await p.evaluate(url => {
      const iframe = document.createElement('iframe');
      iframe.src = url;
      document.body.append(iframe);
    }, frameUrl);
    const frame = await p.waitForFrame(
      candidate => candidate.url() === frameUrl,
    );
    await frame.waitForSelector('html');
    const raw: unknown = await frame.evaluate(identitySource);
    assert.deepEqual(identitySchema.parse(raw), await identity(p));
  });

  it('preserves ordinary page timers when anti-devtools compatibility is enabled', async () => {
    const p = await page();
    await p.evaluate(
      `window.timerResult = false; setTimeout(() => {window.timerResult = outerWidth > 0;}, 150)`,
    );
    await applyAntiDevtoolsDetection(p);
    await setTimeout(250);
    assert.equal(await p.evaluate('window.timerResult'), true);
  });

  it('uses a new context after reset while existing and named sessions remain stable', async () => {
    const p = await page();
    const oldContext = p.browserContext();
    const old = await identity(p);
    const oldScreen = await p.evaluate(() => ({
      width: screen.width,
      height: screen.height,
    }));
    await resetFingerprint(fingerprintFile);
    const nextContext = await prepareFingerprintContext(browser);
    assert.notEqual(nextContext, oldContext);
    const next = await nextContext.newPage();
    await applyStealthToPage(next);
    await next.goto(server.getRoute('/page'));
    assert.doesNotMatch((await identity(next)).userAgent, /HeadlessChrome/);
    assert.deepEqual(await identity(p), old);
    assert.deepEqual(
      await p.evaluate(() => ({width: screen.width, height: screen.height})),
      oldScreen,
    );
    assert.equal(
      await prepareFingerprintContext(browser, oldContext),
      oldContext,
    );
    await p.reload();
    assert.deepEqual(await identity(p), old);
  });
});
