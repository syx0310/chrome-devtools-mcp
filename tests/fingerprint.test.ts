/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {
  fingerprintPlatform,
  generateFingerprint,
  loadFingerprint,
  readFingerprintRevision,
  resetFingerprint,
  type BrowserFingerprintFacts,
} from '../src/fingerprint.js';

const platforms = [
  {os: 'windows', platform: 'Win32', ua: 'Windows NT 10.0; Win64; x64'},
  {os: 'linux', platform: 'Linux x86_64', ua: 'X11; Linux x86_64'},
  {os: 'macos', platform: 'MacIntel', ua: 'Macintosh; Intel Mac OS X 10_15_7'},
];

function facts(platform = platforms[0]): BrowserFingerprintFacts {
  assert.ok(platform);
  return {
    userAgent: `Mozilla/5.0 (${platform.ua}) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36`,
    version: 'Chrome/152.0.7977.76',
    navigatorPlatform: platform.platform,
    languages: ['zh-CN', 'zh'],
    userAgentMetadata: {
      brands: [{brand: 'Chromium', version: '152'}],
      fullVersionList: [{brand: 'Chromium', version: '152.0.7977.76'}],
      fullVersion: '152.0.7977.76',
      platform:
        platform.os === 'macos'
          ? 'macOS'
          : platform.os === 'windows'
            ? 'Windows'
            : 'Linux',
      platformVersion: platform.os === 'linux' ? '' : '10.0.0',
      architecture: 'x86',
      bitness: '64',
      model: '',
      mobile: false,
    },
  };
}

describe('fingerprint profiles', () => {
  let directory: string;
  let stateFile: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fingerprint-test-'));
    stateFile = path.join(directory, 'state.json');
  });
  afterEach(async () => {
    await fs.rm(directory, {recursive: true, force: true});
  });

  for (const platform of platforms) {
    it(`generates a Chrome profile for ${platform.os} independently of the MCP host`, () => {
      for (let sample = 0; sample < 20; sample++) {
        const profile = generateFingerprint(facts(platform), randomUUID());
        assert.equal(profile.platform, platform.os);
        assert.equal(profile.navigatorPlatform, platform.platform);
        assert.match(profile.userAgent, /Chrome\/152\./);
        assert.doesNotMatch(profile.userAgent, /HeadlessChrome/);
        assert.deepEqual(profile.languages, ['zh-CN', 'zh']);
        assert.ok(
          profile.userAgentMetadata.brands.some(
            brand => brand.brand === 'Chromium' && brand.version === '152',
          ),
        );
        assert.equal(profile.userAgentMetadata.fullVersion, '152.0.7977.76');
      }
    });
  }

  it('does not classify Android as desktop Linux', () => {
    assert.throws(
      () => fingerprintPlatform('Mozilla/5.0 (Linux; Android 15)'),
      /desktop Chrome/,
    );
  });

  it('does not let the generator reorder the browser locale preferences', () => {
    const browser = facts();
    Object.freeze(browser.languages);
    const profile = generateFingerprint(browser, randomUUID());
    assert.deepEqual(profile.languages, ['zh-CN', 'zh']);
    assert.deepEqual(browser.languages, ['zh-CN', 'zh']);
  });

  it('respects explicit viewport, platform window borders and physical CPU limit', () => {
    const browser = facts();
    browser.viewport = {width: 1501, height: 801};
    browser.windowInsets = {width: 16, height: 96};
    browser.hardwareConcurrency = 2;
    const profile = generateFingerprint(browser, randomUUID());
    assert.deepEqual(profile.viewport, browser.viewport);
    assert.deepEqual(profile.window, {width: 1517, height: 897});
    assert.ok(profile.screen.width >= profile.window.width);
    assert.ok(profile.screen.height >= profile.window.height);
    assert.ok(profile.hardwareConcurrency <= 2);
  });

  it('keeps the browser native architecture and legacy platform pairing', () => {
    const browser = facts(platforms[2]);
    browser.userAgentMetadata = {
      brands: [{brand: 'Chromium', version: '152'}],
      fullVersionList: [{brand: 'Chromium', version: '152.0.7977.76'}],
      fullVersion: '152.0.7977.76',
      platform: 'macOS',
      platformVersion: '27.0.0',
      architecture: 'arm',
      bitness: '64',
      model: '',
      mobile: false,
    };
    const profile = generateFingerprint(browser, randomUUID());
    assert.equal(profile.navigatorPlatform, 'MacIntel');
    assert.equal(profile.userAgentMetadata.architecture, 'arm');
  });

  it('atomically creates one revision and reuses the saved profile', async () => {
    const revisions = await Promise.all(
      Array.from({length: 8}, () => readFingerprintRevision(stateFile)),
    );
    assert.equal(new Set(revisions).size, 1);
    const revision = revisions[0];
    assert.ok(revision);
    const profiles = await Promise.all(
      Array.from({length: 4}, () =>
        loadFingerprint(stateFile, facts(), revision),
      ),
    );
    assert.equal(new Set(profiles.map(profile => profile.id)).size, 1);
    assert.deepEqual(
      await loadFingerprint(stateFile, facts(), revision),
      profiles[0],
    );
  });

  it('rotates new profiles while retaining the prior profile', async () => {
    const revision = await readFingerprintRevision(stateFile);
    const old = await loadFingerprint(stateFile, facts(), revision);
    const reset = await resetFingerprint(stateFile);
    assert.notEqual(reset.revision, revision);
    const next = await loadFingerprint(stateFile, facts(), reset.revision);
    assert.notEqual(next.id, old.id);
    assert.deepEqual(await loadFingerprint(stateFile, facts(), revision), old);
    assert.equal(await readFingerprintRevision(stateFile), reset.revision);
  });

  it('keeps a concurrent old generation from undoing a reset', async () => {
    const oldRevision = await readFingerprintRevision(stateFile);
    const reset = await resetFingerprint(stateFile);
    await loadFingerprint(stateFile, facts(), oldRevision);
    assert.equal(await readFingerprintRevision(stateFile), reset.revision);
  });

  it('reports corrupt state and lets the CLI reset recover it', async () => {
    await fs.writeFile(stateFile, '{broken');
    await assert.rejects(
      readFingerprintRevision(stateFile),
      /--reset-fingerprint/,
    );
    const reset = await resetFingerprint(stateFile);
    assert.equal(await readFingerprintRevision(stateFile), reset.revision);
  });
});
