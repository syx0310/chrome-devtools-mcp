/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {it, describe} from 'node:test';
import {promisify} from 'node:util';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {executablePath} from 'puppeteer';

import {
  readFingerprintRevision,
  fingerprintSchema,
} from '../../src/fingerprint.js';
import {zod} from '../../src/third_party/index.js';
import {serverHooks} from '../server.js';

const execute = promisify(execFile);
const resultSchema = zod.object({
  isError: zod.boolean().optional(),
  content: zod.array(
    zod.object({type: zod.string(), text: zod.string().optional()}),
  ),
  structuredContent: zod.unknown().optional(),
});
const pagesSchema = zod.object({
  pages: zod.array(
    zod.object({
      id: zod.number(),
      selected: zod.boolean(),
      isolatedContext: zod.string().optional(),
    }),
  ),
});

describe('standalone fingerprint reset', () => {
  const server = serverHooks();

  it('rotates a live MCP session from another CLI process without changing existing pages', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fingerprint-reset-'),
    );
    const stateFile = path.join(directory, 'fingerprint.json');
    const entry = path.resolve('build/src/bin/chrome-devtools-mcp.js');
    const reset = () =>
      execute(
        process.execPath,
        [entry, '--reset-fingerprint', '--fingerprint-file', stateFile],
        {timeout: 10000},
      );
    const cold = await reset();
    assert.match(cold.stdout, /Fingerprint reset:/);
    const beforeRevision = await readFingerprintRevision(stateFile);
    server.addHtmlRoute(
      '/reset-test',
      '<!doctype html><title>Reset test</title><body>Ready</body>',
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        entry,
        '--headless',
        '--isolated',
        '--executable-path',
        await executablePath(),
        '--fingerprint-file',
        stateFile,
        '--experimental-structured-content',
      ],
      env: {
        ...process.env,
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: 'true',
      },
      stderr: 'pipe',
    });
    const client = new Client({
      name: 'fingerprint-reset-test',
      version: '1.0.0',
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = resultSchema.parse(
        await client.callTool({name, arguments: args}),
      );
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result;
    };
    const newPage = async (isolatedContext?: string) => {
      const result = await call('new_page', {
        url: server.getRoute('/reset-test'),
        ...(isolatedContext ? {isolatedContext} : {}),
      });
      const selected = pagesSchema
        .parse(result.structuredContent)
        .pages.find(page => page.selected);
      assert.ok(selected, JSON.stringify(result));
      return selected;
    };
    const evaluate = async (
      pageId: number,
      script: string,
    ): Promise<unknown> => {
      const result = await call('evaluate_script', {pageId, function: script});
      const text = result.content.map(part => part.text ?? '').join('\n');
      const json = text.match(/```json\n([\s\S]*?)\n```/)?.[1];
      assert.ok(json, text);
      return JSON.parse(json);
    };
    try {
      await client.connect(transport);
      const pinned = await newPage('pinned');
      const initial = await evaluate(
        pinned.id,
        `() => {localStorage.setItem('session', 'retained'); return {ua:navigator.userAgent, cpu:navigator.hardwareConcurrency, width:screen.width, height:screen.height};}`,
      );
      const output = await reset();
      assert.match(
        output.stdout,
        /Existing pages and named sessions are unchanged/,
      );
      const afterRevision = await readFingerprintRevision(stateFile);
      assert.notEqual(afterRevision, beforeRevision);
      const fresh = await newPage();
      assert.notEqual(fresh.id, pinned.id);
      const freshData = zod
        .object({ua: zod.string(), session: zod.string().nullable()})
        .parse(
          await evaluate(
            fresh.id,
            `() => ({ua:navigator.userAgent, session:localStorage.getItem('session')})`,
          ),
        );
      assert.doesNotMatch(freshData.ua, /HeadlessChrome/);
      assert.equal(freshData.session, null);
      assert.deepEqual(
        await evaluate(
          pinned.id,
          `() => ({ua:navigator.userAgent, cpu:navigator.hardwareConcurrency, width:screen.width, height:screen.height})`,
        ),
        initial,
      );
      const continued = await newPage('pinned');
      assert.equal(
        await evaluate(continued.id, `() => localStorage.getItem('session')`),
        'retained',
      );
      const profileFiles = await fs.readdir(`${stateFile}.profiles`);
      const ids = new Set<string>();
      for (const file of profileFiles) {
        const profile = fingerprintSchema.parse(
          JSON.parse(
            await fs.readFile(path.join(`${stateFile}.profiles`, file), 'utf8'),
          ),
        );
        ids.add(profile.id);
      }
      assert.equal(ids.size, 2);
    } finally {
      await client.close();
      await fs.rm(directory, {recursive: true, force: true});
    }
  });
});
