/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';

import {zod, type CdpCDPSession, type Protocol} from './third_party/index.js';
import {logger} from './utils/logger.js';

export type RuntimeSender = (
  method: string,
  ...args: unknown[]
) => Promise<unknown>;

interface FrameTree {
  frame: {id: string; url: string; securityOrigin?: string};
  childFrames?: FrameTree[];
}
const treeSchema: zod.ZodType<FrameTree> = zod.object({
  frame: zod.object({
    id: zod.string(),
    url: zod.string(),
    securityOrigin: zod.string().optional(),
  }),
  childFrames: zod.array(zod.lazy(() => treeSchema)).optional(),
});
const frameTreeSchema = zod.object({frameTree: treeSchema});
const nodeSchema = zod.object({
  backendNodeId: zod.number(),
  contentDocument: zod.object({backendNodeId: zod.number()}).optional(),
});
const objectSchema = zod.object({
  result: zod.object({objectId: zod.string().optional()}),
  exceptionDetails: zod.unknown().optional(),
});
const worldSchema = zod.object({executionContextId: zod.number()});
const parametersSchema = zod.record(zod.string(), zod.unknown());

interface KnownContext {
  id: number;
  frameId?: string;
  name: string;
  uniqueId: string;
}

/** Execution-context discovery without a persistent Runtime subscription. */
export class RuntimeBridge {
  readonly #session: CdpCDPSession;
  readonly #send: RuntimeSender;
  readonly #mapper: () => Promise<CdpCDPSession>;
  readonly #collectConsole: boolean;
  readonly #bindingName = 'context_' + randomUUID().replaceAll('-', '');
  readonly #contexts = new Map<number, KnownContext>();
  readonly #aliases = new Map<string, number>();
  readonly #worlds = new Map<string, {grantUniveralAccess?: boolean}>();
  readonly #logs: Protocol.Console.ConsoleMessage[] = [];
  #enabled = false;
  #page = false;
  #ready?: Promise<void>;
  #refreshNeeded = false;
  #refreshing?: Promise<void>;
  #exceptionId = 0;

  constructor(
    session: CdpCDPSession,
    send: RuntimeSender,
    mapper: () => Promise<CdpCDPSession>,
    collectConsole: boolean,
  ) {
    this.#session = session;
    this.#send = send;
    this.#mapper = mapper;
    this.#collectConsole = collectConsole;
    session.on('Runtime.bindingCalled', this.#bindingCalled);
    session.on('Page.frameNavigated', this.#frameNavigated);
    session.on('Page.frameAttached', this.#frameAttached);
    session.on('Page.frameDetached', this.#frameDetached);
    if (collectConsole) {
      session.on('Console.messageAdded', this.#consoleMessage);
    }
  }

  async enable(): Promise<Record<string, never>> {
    this.#enabled = true;
    this.#ready ??= this.#initialize().catch(error => {
      this.#ready = undefined;
      throw error;
    });
    await this.#ready;
    return {};
  }

  async disable(): Promise<void> {
    this.#enabled = false;
    this.#ready = undefined;
    this.#logs.length = 0;
    if (this.#collectConsole) {
      await this.#send('Console.disable');
    }
  }

  dispose(): void {
    this.#enabled = false;
    this.#session.off('Runtime.bindingCalled', this.#bindingCalled);
    this.#session.off('Page.frameNavigated', this.#frameNavigated);
    this.#session.off('Page.frameAttached', this.#frameAttached);
    this.#session.off('Page.frameDetached', this.#frameDetached);
    this.#session.off('Console.messageAdded', this.#consoleMessage);
    this.#contexts.clear();
    this.#aliases.clear();
    this.#logs.length = 0;
  }

  parameters(method: string, args: unknown[]): unknown[] {
    const parsed = parametersSchema.safeParse(args[0]);
    if (!parsed.success) {
      return args;
    }
    const params = parsed.data;
    if (
      (method === 'Page.addScriptToEvaluateOnNewDocument' ||
        method === 'Page.createIsolatedWorld') &&
      typeof params.worldName === 'string'
    ) {
      this.#worlds.set(params.worldName, {
        grantUniveralAccess:
          typeof params.grantUniveralAccess === 'boolean'
            ? params.grantUniveralAccess
            : true,
      });
    }
    if (
      (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') &&
      typeof params.uniqueContextId === 'string'
    ) {
      const id = this.#aliases.get(params.uniqueContextId);
      if (id !== undefined) {
        const {uniqueContextId: _uniqueContextId, ...rest} = params;
        return [
          {
            ...rest,
            [method === 'Runtime.callFunctionOn'
              ? 'executionContextId'
              : 'contextId']: id,
          },
          ...args.slice(1),
        ];
      }
    }
    return args;
  }

  async response(
    method: string,
    args: unknown[],
    response: Promise<unknown>,
  ): Promise<unknown> {
    const result = await response;
    if (method === 'Page.createIsolatedWorld') {
      const params = parametersSchema.parse(args[0]);
      if (typeof params.frameId === 'string') {
        this.#publish(
          worldSchema.parse(result).executionContextId,
          params.frameId,
          typeof params.worldName === 'string' ? params.worldName : '',
        );
      }
    }
    return result;
  }

  #source(): string {
    const name = JSON.stringify(this.#bindingName);
    const payload = JSON.stringify(JSON.stringify({type: 'runtime-context'}));
    return `(() => {
      const callback = globalThis[${name}];
      if (typeof callback !== 'function') return;
      delete globalThis[${name}];
      callback(${payload});
    })();`;
  }

  async #initialize(): Promise<void> {
    try {
      frameTreeSchema.parse(await this.#send('Page.getFrameTree'));
      this.#page = true;
    } catch {
      this.#page = false;
    }
    if (this.#collectConsole) {
      await this.#send('Console.enable');
    }
    if (this.#page) {
      // Keep DOM node bookkeeping isolated from DevTools' own DOMModel.
      await this.#mapper();
      await this.#send('Page.enable');
      await this.#refresh();
    } else {
      await this.#send('Runtime.evaluate', {
        expression: '0',
        returnByValue: true,
      });
      await this.#send('Runtime.addBinding', {name: this.#bindingName});
      try {
        await this.#send('Runtime.evaluate', {
          expression: this.#source(),
          returnByValue: true,
        });
      } finally {
        await this.#send('Runtime.removeBinding', {name: this.#bindingName});
      }
    }
  }

  #refresh(): Promise<void> {
    this.#refreshNeeded = true;
    this.#refreshing ??= (async () => {
      while (this.#enabled && this.#refreshNeeded) {
        this.#refreshNeeded = false;
        // Runtime bindings need to be reinstalled after navigation when the
        // Runtime domain is disabled. The binding is removed before app use.
        await this.#send('Runtime.addBinding', {name: this.#bindingName});
        try {
          const {identifier} = zod.object({identifier: zod.string()}).parse(
            await this.#send('Page.addScriptToEvaluateOnNewDocument', {
              source: this.#source(),
              runImmediately: true,
            }),
          );
          await this.#send('Page.removeScriptToEvaluateOnNewDocument', {
            identifier,
          });
        } finally {
          await this.#send('Runtime.removeBinding', {
            name: this.#bindingName,
          });
        }
      }
    })().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  #bindingCalled = (event: Protocol.Runtime.BindingCalledEvent): void => {
    if (this.#enabled && event.name === this.#bindingName) {
      void this.#contextCreated(event.executionContextId).catch(error =>
        logger?.('Runtime context discovery interrupted', error),
      );
    }
  };

  #frameNavigated = (event: Protocol.Page.FrameNavigatedEvent): void => {
    if (!this.#enabled) {
      return;
    }
    this.#destroyFrame(event.frame.id, !event.frame.parentId);
    void this.#restoreWorlds(event.frame.id).catch(error =>
      logger?.('Runtime utility world navigation interrupted', error),
    );
    this.#frameAttached();
  };

  #frameAttached = (): void => {
    if (this.#enabled && this.#page) {
      void this.#refresh().catch(error =>
        logger?.('Runtime context refresh interrupted', error),
      );
    }
  };

  #frameDetached = (event: Protocol.Page.FrameDetachedEvent): void => {
    if (this.#enabled) {
      this.#destroyFrame(event.frameId);
    }
  };

  #destroyFrame(frameId: string, all = false): void {
    for (const [id, context] of this.#contexts) {
      if (all || context.frameId === frameId) {
        this.#contexts.delete(id);
        this.#aliases.delete(context.uniqueId);
        this.#session.emit('Runtime.executionContextDestroyed', {
          executionContextId: id,
          executionContextUniqueId: context.uniqueId,
        });
      }
    }
  }

  #publish(id: number, frameId?: string, name = '', origin = ''): void {
    if (!this.#enabled || this.#contexts.has(id)) {
      return;
    }
    const uniqueId = randomUUID();
    this.#contexts.set(id, {id, frameId, name, uniqueId});
    this.#aliases.set(uniqueId, id);
    this.#session.emit('Runtime.executionContextCreated', {
      context: {
        id,
        uniqueId,
        origin,
        name,
        auxData: frameId
          ? {frameId, isDefault: !name, type: name ? 'isolated' : 'default'}
          : {isDefault: true},
      },
    });
    this.#flushLogs();
  }

  async #contextCreated(id: number): Promise<void> {
    if (this.#contexts.has(id)) {
      return;
    }
    if (!this.#page) {
      this.#publish(id);
      return;
    }
    const {result, exceptionDetails} = objectSchema.parse(
      await this.#send('Runtime.evaluate', {
        expression: 'document',
        contextId: id,
        returnByValue: false,
      }),
    );
    if (exceptionDetails || !result.objectId) {
      return;
    }
    const objectId = result.objectId;
    try {
      const {node} = zod
        .object({node: nodeSchema})
        .parse(await this.#send('DOM.describeNode', {objectId, depth: 0}));
      const mapper = await this.#mapper();
      const {frameTree} = await mapper.send('Page.getFrameTree');
      const {root} = await mapper.send('DOM.getDocument', {depth: 0});
      let frame =
        root.backendNodeId === node.backendNodeId ? frameTree.frame : undefined;
      const pending = [...(frameTree.childFrames ?? [])];
      while (!frame && pending.length) {
        const child = pending.shift();
        if (!child) {
          break;
        }
        pending.push(...(child.childFrames ?? []));
        try {
          const owner = await mapper.send('DOM.getFrameOwner', {
            frameId: child.frame.id,
          });
          const {node: element} = await mapper.send('DOM.describeNode', {
            backendNodeId: owner.backendNodeId,
            depth: 0,
            pierce: true,
          });
          if (element.contentDocument?.backendNodeId === node.backendNodeId) {
            frame = child.frame;
          }
        } catch {
          // A frame may detach while its execution context is discovered.
        }
      }
      if (frame) {
        this.#publish(id, frame.id, '', frame.securityOrigin);
        await this.#restoreWorlds(frame.id);
      }
    } finally {
      await this.#send('Runtime.releaseObject', {objectId}).catch(
        () => undefined,
      );
    }
  }

  async #restoreWorlds(frameId: string): Promise<void> {
    for (const [worldName, options] of this.#worlds) {
      const result = worldSchema.parse(
        await this.#send('Page.createIsolatedWorld', {
          ...options,
          frameId,
          worldName,
        }),
      );
      this.#publish(result.executionContextId, frameId, worldName);
    }
  }

  #consoleMessage = (event: Protocol.Console.MessageAddedEvent): void => {
    if (
      !this.#enabled ||
      !['console-api', 'javascript'].includes(event.message.source)
    ) {
      return;
    }
    this.#logs.push(event.message);
    if (this.#logs.length > 1000) {
      this.#logs.shift();
    }
    this.#flushLogs();
  };

  #flushLogs(): void {
    const context = [...this.#contexts.values()].find(context => !context.name);
    if (!context) {
      return;
    }
    for (const message of this.#logs.splice(0)) {
      const stackTrace = {
        callFrames: [
          {
            functionName: '',
            scriptId: '0',
            url: message.url ?? '',
            lineNumber: Math.max(0, (message.line ?? 1) - 1),
            columnNumber: Math.max(0, (message.column ?? 1) - 1),
          },
        ],
      };
      if (message.source === 'javascript') {
        this.#session.emit('Runtime.exceptionThrown', {
          timestamp: Date.now(),
          exceptionDetails: {
            exceptionId: ++this.#exceptionId,
            text: message.text,
            url: message.url,
            lineNumber: stackTrace.callFrames[0]?.lineNumber ?? 0,
            columnNumber: stackTrace.callFrames[0]?.columnNumber ?? 0,
            executionContextId: context.id,
            stackTrace,
          },
        });
      } else {
        this.#session.emit('Runtime.consoleAPICalled', {
          type: message.level,
          args: [{type: 'string', value: message.text}],
          executionContextId: context.id,
          timestamp: Date.now(),
          stackTrace,
        });
      }
    }
  }
}
