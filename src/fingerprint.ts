/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {FingerprintGenerator} from './third_party/fingerprint-generator.js';
import {zod} from './third_party/index.js';

const stateSchema = zod.object({
  schemaVersion: zod.literal(1),
  revision: zod.string().uuid(),
});
const brandSchema = zod.object({brand: zod.string(), version: zod.string()});
export const fingerprintSchema = zod.object({
  schemaVersion: zod.literal(1),
  revision: zod.string().uuid(),
  id: zod.string().uuid(),
  browserKey: zod.string().regex(/^[a-f0-9]{64}$/),
  platform: zod.enum(['windows', 'macos', 'linux']),
  userAgent: zod.string().min(1),
  navigatorPlatform: zod.string().min(1),
  languages: zod.array(zod.string().min(1)).min(1),
  userAgentMetadata: zod.object({
    brands: zod.array(brandSchema),
    fullVersionList: zod.array(brandSchema),
    fullVersion: zod.string(),
    platform: zod.string(),
    platformVersion: zod.string(),
    architecture: zod.string(),
    bitness: zod.string(),
    model: zod.string(),
    mobile: zod.boolean(),
  }),
  hardwareConcurrency: zod.number().int().min(1).max(256),
  viewport: zod.object({
    width: zod.number().int().min(1),
    height: zod.number().int().min(1),
  }),
  window: zod.object({
    width: zod.number().int().min(1),
    height: zod.number().int().min(1),
  }),
  screen: zod.object({
    width: zod.number().int().min(320).max(16384),
    height: zod.number().int().min(240).max(16384),
    deviceScaleFactor: zod.number().min(0.25).max(8),
  }),
});

export type FingerprintProfile = zod.infer<typeof fingerprintSchema>;
export interface BrowserFingerprintFacts {
  userAgent: string;
  version: string;
  navigatorPlatform: string;
  languages: string[];
  userAgentMetadata: FingerprintProfile['userAgentMetadata'];
  hardwareConcurrency?: number;
  windowInsets?: {width: number; height: number};
  viewport?: {width: number; height: number};
}

export function fingerprintPlatform(userAgent: string) {
  if (/Windows NT/.test(userAgent)) {
    return 'windows';
  }
  if (/Macintosh|Mac OS X/.test(userAgent)) {
    return 'macos';
  }
  if (/Linux|X11/.test(userAgent) && !/Android/.test(userAgent)) {
    return 'linux';
  }
  throw new Error(
    'Fingerprint generation requires desktop Chrome on Windows, macOS, or Linux.',
  );
}

export function resolveFingerprintFile(filePath?: string): string {
  return path.resolve(
    filePath ??
      process.env['CHROME_DEVTOOLS_MCP_FINGERPRINT_FILE'] ??
      path.join(
        os.homedir(),
        '.cache',
        'chrome-devtools-mcp',
        'fingerprint.json',
      ),
  );
}

function isFileError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Publish complete JSON without exposing a partially written file to readers. */
async function writeJson(
  filePath: string,
  value: unknown,
  replace: boolean,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), {recursive: true, mode: 0o700});
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    if (replace) {
      await fs.rename(temporary, filePath);
    } else {
      // A hard link atomically elects one writer even across MCP processes.
      try {
        await fs.link(temporary, filePath);
      } catch (error) {
        if (!isFileError(error, 'EEXIST')) {
          throw error;
        }
      }
    }
  } finally {
    await fs.rm(temporary, {force: true});
  }
}

export async function resetFingerprint(filePath = resolveFingerprintFile()) {
  const state = {schemaVersion: 1, revision: randomUUID()};
  await writeJson(filePath, state, true);
  return {filePath, revision: state.revision};
}

export async function readFingerprintRevision(
  filePath: string,
): Promise<string> {
  try {
    return stateSchema.parse(JSON.parse(await fs.readFile(filePath, 'utf8')))
      .revision;
  } catch (error) {
    if (!isFileError(error, 'ENOENT')) {
      throw new Error(
        `Cannot read fingerprint state ${filePath}. Use --reset-fingerprint to reset it.`,
        {cause: error},
      );
    }
  }
  await writeJson(filePath, {schemaVersion: 1, revision: randomUUID()}, false);
  return stateSchema.parse(JSON.parse(await fs.readFile(filePath, 'utf8')))
    .revision;
}

let generator: FingerprintGenerator | undefined;

export function generateFingerprint(
  facts: BrowserFingerprintFacts,
  revision: string,
): FingerprintProfile {
  const platform = fingerprintPlatform(facts.userAgent);
  const version = facts.version.match(
    /(?:Chrome|HeadlessChrome)\/(\d+(?:\.\d+)*)/,
  )?.[1];
  if (!version) {
    throw new Error(`Cannot determine Chrome version from ${facts.version}`);
  }
  const major = Number(version.split('.')[0]);
  generator ??= new FingerprintGenerator();
  const generated = generator.getFingerprint({
    // Apify supplies device characteristics. Browser versions and Client Hints
    // are taken from Chrome itself, so a lagging dataset cannot downgrade the
    // browser identity or relax the operating-system constraint.
    browsers: ['chrome'],
    operatingSystems: [platform],
    devices: ['desktop'],
    locales: [...facts.languages],
    strict: true,
  }).fingerprint;
  const metadata = facts.userAgentMetadata;
  const chromeBrand = (brand: string) => /Chromium|Google Chrome/.test(brand);
  const insets = facts.windowInsets ?? {width: 0, height: 0};
  const viewport = facts.viewport ?? {
    width: Math.max(320, generated.screen.width - insets.width),
    height: Math.max(240, generated.screen.height - insets.height),
  };
  const window = {
    width: viewport.width + insets.width,
    height: viewport.height + insets.height,
  };
  return fingerprintSchema.parse({
    schemaVersion: 1,
    revision,
    id: randomUUID(),
    browserKey: fingerprintBrowserKey(facts),
    platform,
    userAgent: facts.userAgent.replaceAll('HeadlessChrome', 'Chrome'),
    navigatorPlatform: facts.navigatorPlatform,
    languages: facts.languages,
    userAgentMetadata: {
      ...metadata,
      brands: metadata.brands.map(brand => ({
        brand: brand.brand,
        version: chromeBrand(brand.brand) ? String(major) : brand.version,
      })),
      fullVersionList: metadata.fullVersionList.map(brand => ({
        brand: brand.brand,
        version: chromeBrand(brand.brand) ? version : brand.version,
      })),
      fullVersion: version,
    },
    hardwareConcurrency: Math.min(
      generated.navigator.hardwareConcurrency,
      facts.hardwareConcurrency ?? 256,
    ),
    viewport,
    window,
    screen: {
      width: Math.max(window.width, generated.screen.width),
      height: Math.max(window.height, generated.screen.height),
      deviceScaleFactor: generated.screen.devicePixelRatio,
    },
  });
}

function fingerprintBrowserKey(facts: BrowserFingerprintFacts): string {
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

/** The revision file is only changed by reset, so generation cannot undo a reset. */
export async function loadFingerprint(
  filePath: string,
  facts: BrowserFingerprintFacts,
  revision: string,
): Promise<FingerprintProfile> {
  const key = fingerprintBrowserKey(facts);
  const profilePath = path.join(
    `${filePath}.profiles`,
    `${revision}-${key}.json`,
  );
  try {
    const profile = fingerprintSchema.parse(
      JSON.parse(await fs.readFile(profilePath, 'utf8')),
    );
    if (profile.revision !== revision || profile.browserKey !== key) {
      throw new Error('Fingerprint does not match its browser or revision');
    }
    return profile;
  } catch (error) {
    if (!isFileError(error, 'ENOENT')) {
      throw new Error(`Cannot read saved fingerprint ${profilePath}`, {
        cause: error,
      });
    }
  }
  await writeJson(profilePath, generateFingerprint(facts, revision), false);
  return fingerprintSchema.parse(
    JSON.parse(await fs.readFile(profilePath, 'utf8')),
  );
}
