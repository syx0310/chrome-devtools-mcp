/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

export const setRuntimeModeTool = defineTool({
  name: 'set_runtime_mode',
  description:
    'Switches all MCP-owned sessions in this browser between stealth collection (text-only console logs) and detailed Runtime debugging. Debug mode exposes CDP signals. Switching back does not erase detections or restore earlier log details; reload the page to start a new measurement.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    mode: zod
      .enum(['stealth', 'debug'])
      .describe(
        'stealth avoids persistent Runtime subscriptions; debug enables full console objects and exception metadata.',
      ),
  },
  blockedByDialog: false,
  verifyFilesSchema: {},
  handler: async (request, response, context) => {
    await context.setRuntimeMode(request.params.mode);
    response.appendResponseLine(
      request.params.mode === 'stealth'
        ? 'Runtime mode: stealth. Console collection contains text summaries. Reload existing pages for a fresh detection measurement.'
        : 'Runtime mode: debug. Detailed console and exception collection is enabled from now on; CDP signals are exposed.',
    );
  },
});
