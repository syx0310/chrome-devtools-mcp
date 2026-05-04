/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {executablePath} from 'puppeteer';

import {detectDisplay, ensureBrowserConnected, launch} from '../src/browser.js';

describe('browser', () => {
  it('detects display does not crash', () => {
    detectDisplay();
  });

  it('cannot launch multiple times with the same profile', async () => {
    const tmpDir = os.tmpdir();
    const folderPath = path.join(tmpDir, `temp-folder-${crypto.randomUUID()}`);
    const browser1 = await launch({
      headless: true,
      isolated: false,
      userDataDir: folderPath,
      executablePath: executablePath(),
      devtools: false,
    });
    try {
      try {
        const browser2 = await launch({
          headless: true,
          isolated: false,
          userDataDir: folderPath,
          executablePath: executablePath(),
          devtools: false,
        });
        await browser2.close();
        assert.fail('not reached');
      } catch (err) {
        assert.strictEqual(
          err.message,
          `The browser is already running for ${folderPath}. Use --isolated to run multiple browser instances.`,
        );
      }
    } finally {
      await browser1.close();
    }
  });

  it('launches with the initial viewport', async () => {
    const tmpDir = os.tmpdir();
    const folderPath = path.join(tmpDir, `temp-folder-${crypto.randomUUID()}`);
    const browser = await launch({
      headless: true,
      isolated: false,
      userDataDir: folderPath,
      executablePath: executablePath(),
      viewport: {
        width: 1501,
        height: 801,
      },
      devtools: false,
    });
    try {
      const [page] = await browser.pages();
      const result = await page.evaluate(() => {
        return {width: window.innerWidth, height: window.innerHeight};
      });
      assert.deepStrictEqual(result, {
        width: 1501,
        height: 801,
      });
    } finally {
      await browser.close();
    }
  });
  it('launches with stealth mode', async () => {
    const browser = await launch({
      headless: true,
      isolated: true,
      executablePath: executablePath(),
      devtools: false,
      stealth: true,
    });
    try {
      const [page] = await browser.pages();
      // Navigate to a blank page so the stealth init script executes.
      await page.goto('about:blank');
      const webdriver = await page.evaluate(() => navigator.webdriver);
      assert.strictEqual(webdriver, false);

      // Verify prototype-level patch (bypasses instance-level overrides)
      const prototypeCheck = await page.evaluate(() => {
        const desc = Object.getOwnPropertyDescriptor(
          Navigator.prototype,
          'webdriver',
        );
        return (
          desc &&
          typeof desc.get === 'function' &&
          desc.get.call(navigator) === false
        );
      });
      assert.strictEqual(prototypeCheck, true);

      // Verify 'webdriver' in navigator (property exists, just returns false)
      const inCheck = await page.evaluate(() => 'webdriver' in navigator);
      assert.strictEqual(inCheck, true);

      // Verify toString() looks native
      const toStringCheck = await page.evaluate(() => {
        const desc = Object.getOwnPropertyDescriptor(
          Navigator.prototype,
          'webdriver',
        );
        return desc!.get!.toString().includes('[native code]');
      });
      assert.strictEqual(toStringCheck, true);
    } finally {
      await browser.close();
    }
  });

  it('launches with anti-devtools-detection mode', async () => {
    const browser = await launch({
      headless: true,
      isolated: true,
      executablePath: executablePath(),
      devtools: false,
      stealth: false,
      antiDevtoolsDetection: true,
    });
    try {
      const [page] = await browser.pages();
      await page.goto('about:blank');

      // Window dimensions consistency
      const dims = await page.evaluate(() => ({
        dw: window.outerWidth - window.innerWidth,
        dh: window.outerHeight - window.innerHeight,
      }));
      assert.strictEqual(dims.dw, 0);
      assert.ok(dims.dh > 0 && dims.dh < 150);

      // document.hasFocus() returns true
      const hasFocus = await page.evaluate(() => document.hasFocus());
      assert.strictEqual(hasFocus, true);

      // console.log looks native
      const logStr = await page.evaluate(() => console.log.toString());
      assert.ok(logStr.includes('[native code]'));

      // Normal timers still work
      const timerWorks = await page.evaluate(
        () =>
          new Promise(resolve => {
            let count = 0;
            const id = setInterval(() => {
              count++;
              if (count >= 2) {
                clearInterval(id);
                resolve(true);
              }
            }, 50);
          }),
      );
      assert.strictEqual(timerWorks, true);

      // performance.now() returns integer (1ms precision)
      const perfRounded = await page.evaluate(() => {
        const v = performance.now();
        return v === Math.round(v);
      });
      assert.strictEqual(perfRounded, true);
    } finally {
      await browser.close();
    }
  });

  it('connects to an existing browser with userDataDir', async () => {
    const tmpDir = os.tmpdir();
    const folderPath = path.join(tmpDir, `temp-folder-${crypto.randomUUID()}`);
    const browser = await launch({
      headless: true,
      isolated: false,
      userDataDir: folderPath,
      executablePath: executablePath(),
      devtools: false,
      chromeArgs: ['--remote-debugging-port=0'],
    });
    try {
      const connectedBrowser = await ensureBrowserConnected({
        userDataDir: folderPath,
        devtools: false,
      });
      assert.ok(connectedBrowser);
      assert.ok(connectedBrowser.connected);
      connectedBrowser.disconnect();
    } finally {
      await browser.close();
    }
  });
});
