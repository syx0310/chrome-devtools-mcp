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

import {executablePath} from 'puppeteer';

import {launch} from '../src/browser.js';
import {McpContext} from '../src/McpContext.js';
import {getRuntimeMode, setRuntimeMode} from '../src/stealthRuntime.js';
import type {Browser} from '../src/third_party/index.js';

import {serverHooks} from './server.js';

const probeSource = `(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  let calls = 0;
  try {
    Error.prepareStackTrace = () => { calls++; return 'application stack'; };
    console.log(new Error('runtime probe'));
    const duringConsole = calls;
    const value = new Error('explicit access').stack;
    return {duringConsole, explicit: calls - duringConsole, value};
  } finally {
    if (descriptor) Object.defineProperty(Error, 'prepareStackTrace', descriptor);
    else delete Error.prepareStackTrace;
  }
})()`;

describe('stealth Runtime collection', () => {
  const server = serverHooks();
  let browser: Browser;
  let context: McpContext;
  let directory: string;

  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stealth-runtime-'));
    browser = await launch({
      headless: true,
      isolated: true,
      executablePath: await executablePath(),
      devtools: false,
      stealth: true,
      experimentalStealthRuntime: true,
      fingerprintFile: path.join(directory, 'fingerprint.json'),
    });
    context = await McpContext.from(browser, () => undefined, {
      experimentalDevToolsDebugging: false,
      performanceCrux: false,
      stealth: true,
    });
  });
  after(async () => {
    context?.dispose();
    await browser?.close();
    await fs.rm(directory, {recursive: true, force: true});
  });

  it('keeps navigation, main-world evaluation, frames and native console working', async () => {
    server.addHtmlRoute('/first', '<!doctype html><title>First</title>');
    server.addHtmlRoute(
      '/second',
      '<!doctype html><title>Second</title><iframe srcdoc="<h1>one</h1>"></iframe><iframe srcdoc="<h1>two</h1>"></iframe>',
    );
    const page = (await context.newPage()).pptrPage;
    await page.goto(server.getRoute('/first'));
    await page.evaluate(() => {
      window.name = 'kept across navigation';
    });
    await page.goto(server.getRoute('/second'));
    assert.equal(await page.title(), 'Second');
    assert.equal(
      await page.evaluate(() => window.name),
      'kept across navigation',
    );
    const frameText: string[] = [];
    for (const frame of page.frames()) {
      if (frame.parentFrame()) {
        frameText.push(
          await frame.evaluate(() => document.body.textContent ?? ''),
        );
      }
    }
    assert.deepEqual(frameText, ['one', 'two']);
    const result: unknown = await page.evaluate(probeSource);
    assert.deepEqual(result, {
      duringConsole: 0,
      explicit: 1,
      value: 'application stack',
    });
    const message = new Promise<string>(resolve => {
      page.once('console', message => resolve(message.text()));
    });
    await page.evaluate(() => console.log('plain log', 42));
    assert.equal(await message, 'plain log 42');
    await page.reload();
    assert.deepEqual(await page.evaluate(probeSource), result);
  });

  it('preserves classic, module and nested worker execution without console serialization', async () => {
    server.addHtmlRoute('/workers', '<!doctype html><title>Workers</title>');
    server.addRoute('/worker.js', (_request, response) => {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(`postMessage(${probeSource});`);
    });
    server.addRoute('/parent-worker.js', (_request, response) => {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(
        "const child = new Worker('./worker.js'); child.onmessage = event => postMessage(event.data);",
      );
    });
    const page = (await context.newPage()).pptrPage;
    await page.goto(server.getRoute('/workers'));
    for (const options of [
      {url: '/worker.js', module: false},
      {url: '/worker.js', module: true},
      {url: '/parent-worker.js', module: false},
    ]) {
      const result: unknown = await page.evaluate(
        options =>
          new Promise((resolve, reject) => {
            const worker = new Worker(options.url, {
              type: options.module ? 'module' : 'classic',
            });
            worker.onmessage = event => {
              worker.terminate();
              resolve(event.data);
            };
            worker.onerror = () => reject(new Error('worker failed'));
          }),
        options,
      );
      assert.deepEqual(result, {
        duringConsole: 0,
        explicit: 1,
        value: 'application stack',
      });
    }
  });

  it('switches debugging on and off without restarting or changing existing storage', async () => {
    server.addHtmlRoute('/switch', '<!doctype html><title>Switch</title>');
    const page = (await context.newPage()).pptrPage;
    await page.goto(server.getRoute('/switch'));
    await page.evaluate(() => localStorage.setItem('session', 'kept'));
    assert.equal(await getRuntimeMode(browser), 'stealth');
    await setRuntimeMode(browser, 'debug');
    assert.equal(await getRuntimeMode(browser), 'debug');
    const debug = await page.evaluate(probeSource);
    assert.deepEqual(debug, {
      duringConsole: 1,
      explicit: 1,
      value: 'application stack',
    });
    await setRuntimeMode(browser, 'stealth');
    assert.equal(await getRuntimeMode(browser), 'stealth');
    await page.reload();
    assert.equal(
      await page.evaluate(() => localStorage.getItem('session')),
      'kept',
    );
    assert.deepEqual(await page.evaluate(probeSource), {
      duringConsole: 0,
      explicit: 1,
      value: 'application stack',
    });
    const next = (await context.newPage()).pptrPage;
    await next.goto(server.getRoute('/switch'));
    assert.deepEqual(await next.evaluate(probeSource), {
      duringConsole: 0,
      explicit: 1,
      value: 'application stack',
    });
  });

  it('maps a cross-origin frame after navigation without inheriting its parent context', async () => {
    server.addHtmlRoute(
      '/child-one',
      '<!doctype html><title>Child one</title>',
    );
    server.addHtmlRoute(
      '/child-two',
      '<!doctype html><title>Child two</title>',
    );
    const first = server
      .getRoute('/child-one')
      .replace('127.0.0.1', 'localhost');
    const second = server
      .getRoute('/child-two')
      .replace('127.0.0.1', 'localhost');
    server.addHtmlRoute(
      '/cross-origin',
      `<!doctype html><title>Parent</title><iframe src="${first}"></iframe>`,
    );
    const page = (await context.newPage()).pptrPage;
    await page.goto(server.getRoute('/cross-origin'));
    const child = page.frames().find(frame => frame.parentFrame());
    assert.ok(child);
    assert.equal(await child.title(), 'Child one');
    await child.goto(second);
    assert.equal(await child.title(), 'Child two');
    assert.equal(await page.title(), 'Parent');
    assert.deepEqual(await child.evaluate(probeSource), {
      duringConsole: 0,
      explicit: 1,
      value: 'application stack',
    });
  });

  it('retains SharedWorker reuse and supports service-worker registration', async () => {
    server.addHtmlRoute('/shared-page', '<!doctype html><title>Shared</title>');
    server.addRoute('/shared-runtime.js', (_request, response) => {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(
        `let connections = 0; onconnect = event => event.ports[0].postMessage({connections: ++connections, probe: ${probeSource}});`,
      );
    });
    server.addRoute('/service-runtime.js', (_request, response) => {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(`const probe = ${probeSource};
        oninstall = () => skipWaiting();
        onactivate = event => event.waitUntil(clients.claim());
        onmessage = event => event.ports[0].postMessage(probe);`);
    });
    const page = (await context.newPage()).pptrPage;
    await page.goto(server.getRoute('/shared-page'));
    const shared: unknown = await page.evaluate(async () => {
      const request = () =>
        new Promise(resolve => {
          const worker = new SharedWorker('/shared-runtime.js', 'reuse');
          worker.port.onmessage = event => resolve(event.data);
          worker.port.start();
        });
      return [await request(), await request()];
    });
    const probe = {duringConsole: 0, explicit: 1, value: 'application stack'};
    assert.deepEqual(shared, [
      {connections: 1, probe},
      {connections: 2, probe},
    ]);
    const service: unknown = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register(
        '/service-runtime.js',
      );
      await navigator.serviceWorker.ready;
      const active = registration.active;
      if (!active) {
        throw new Error('Missing service worker');
      }
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Service worker response timed out')),
          10000,
        );
        const channel = new MessageChannel();
        channel.port1.onmessage = event => {
          clearTimeout(timeout);
          resolve(event.data);
        };
        active.postMessage('probe', [channel.port2]);
      });
    });
    assert.deepEqual(service, probe);
  });
});
