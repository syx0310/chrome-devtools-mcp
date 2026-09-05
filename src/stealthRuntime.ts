/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AsyncLocalStorage} from 'node:async_hooks';

import {RuntimeBridge, type RuntimeSender} from './RuntimeBridge.js';
import {
  CdpCDPSession,
  CDPSessionEvent,
  Mutex,
  zod,
  type Browser,
  type CDPSession,
  type Page,
} from './third_party/index.js';
import {logger} from './utils/logger.js';

export type RuntimeMode = 'debug' | 'stealth';
interface Scope {
  limit: number | null;
  mode: RuntimeMode;
}
interface SessionState {
  session: CdpCDPSession;
  send: RuntimeSender;
  requested: boolean;
  bridge?: RuntimeBridge;
}
interface Policy extends Scope {
  sessions: Map<string, SessionState>;
  mappers: Map<string, Promise<CdpCDPSession>>;
  mapperIds: Map<string, string>;
  mutex: Mutex;
}

const scope = new AsyncLocalStorage<Scope>();
const policies = new WeakMap<object, Policy>();
const devtoolsSessions = new WeakSet<object>();
const originalSend = CdpCDPSession.prototype.send;

export function markDevToolsRuntimeSession(session: CDPSession): void {
  if (devtoolsSessions.has(session)) {
    return;
  }
  devtoolsSessions.add(session);
  session.on(CDPSessionEvent.SessionAttached, markDevToolsRuntimeSession);
}

function policyFor(session: CdpCDPSession): Policy | undefined {
  const connection = session.connection();
  if (!connection) {
    return;
  }
  let policy = policies.get(connection);
  if (!policy) {
    const created: Policy = {
      ...(scope.getStore() ?? {limit: null, mode: 'debug'}),
      sessions: new Map(),
      mappers: new Map(),
      mapperIds: new Map(),
      mutex: new Mutex(),
    };
    policies.set(connection, created);
    connection.on(CDPSessionEvent.SessionDetached, closed => {
      created.sessions.get(closed.id())?.bridge?.dispose();
      created.sessions.delete(closed.id());
      const targetId = created.mapperIds.get(closed.id());
      if (targetId) {
        created.mappers.delete(targetId);
        created.mapperIds.delete(closed.id());
      }
    });
    policy = created;
  }
  return policy;
}

function stateFor(policy: Policy, session: CdpCDPSession): SessionState {
  const existing = policy.sessions.get(session.id());
  if (existing) {
    return existing;
  }
  const send: RuntimeSender = (method, ...args) => {
    const result: unknown = Reflect.apply(originalSend, session, [
      method,
      ...args,
    ]);
    return Promise.resolve(result);
  };
  const created: SessionState = {session, send, requested: false};
  policy.sessions.set(session.id(), created);
  return created;
}

async function mapperFor(
  policy: Policy,
  state: SessionState,
): Promise<CdpCDPSession> {
  const connection = state.session.connection();
  if (!connection) {
    throw new Error('Runtime session has disconnected');
  }
  const {targetInfo} = zod
    .object({
      targetInfo: zod.object({targetId: zod.string()}),
    })
    .parse(await state.send('Target.getTargetInfo'));
  let mapper = policy.mappers.get(targetInfo.targetId);
  if (!mapper) {
    mapper = connection._createSession({targetId: targetInfo.targetId});
    policy.mappers.set(targetInfo.targetId, mapper);
    void mapper.then(
      session => policy.mapperIds.set(session.id(), targetInfo.targetId),
      () => undefined,
    );
    void mapper.catch(() => policy.mappers.delete(targetInfo.targetId));
  }
  return mapper;
}

function bridgeFor(policy: Policy, state: SessionState): RuntimeBridge {
  state.bridge ??= new RuntimeBridge(
    state.session,
    state.send,
    () => mapperFor(policy, state),
    !devtoolsSessions.has(state.session),
  );
  return state.bridge;
}

function enableDebug(
  policy: Policy,
  state: SessionState,
  args: unknown[] = [],
): Promise<unknown> {
  const response = state.send('Runtime.enable', ...args);
  if (policy.limit === null) {
    return response;
  }
  // Queue the cap before a worker's runIfWaitingForDebugger command.
  const configured = state
    .send('Runtime.setMaxCallStackSizeToCapture', {
      size: policy.limit,
    })
    .catch(error => {
      logger?.('Could not limit automatic Runtime stack capture', error);
    });
  return Promise.all([response, configured]).then(([result]) => result);
}

Object.defineProperty(CdpCDPSession.prototype, 'send', {
  configurable: true,
  writable: true,
  value: function (
    this: CdpCDPSession,
    method: string,
    ...args: unknown[]
  ): Promise<unknown> {
    const policy = policyFor(this);
    if (!policy) {
      const result: unknown = Reflect.apply(originalSend, this, [
        method,
        ...args,
      ]);
      return Promise.resolve(result);
    }
    const state = stateFor(policy, this);
    if (method === 'Runtime.enable') {
      state.requested = true;
      return policy.mode === 'stealth'
        ? bridgeFor(policy, state).enable()
        : enableDebug(policy, state, args);
    }
    if (method === 'Runtime.disable') {
      state.requested = false;
      return Promise.resolve(state.bridge?.disable()).then(() =>
        state.send(method, ...args),
      );
    }
    if (policy.mode === 'stealth' && state.bridge) {
      const parameters = state.bridge.parameters(method, args);
      return state.bridge.response(
        method,
        parameters,
        state.send(method, ...parameters),
      );
    }
    return state.send(method, ...args);
  },
});

export function withStealthStackCapture<T>(
  stealth: boolean | undefined,
  action: () => Promise<T>,
  passive = false,
): Promise<T> {
  return scope.run(
    {limit: stealth ? 10 : null, mode: passive ? 'stealth' : 'debug'},
    action,
  );
}

function hasClient(page: Page): page is Page & {_client(): CDPSession} {
  return '_client' in page && typeof page._client === 'function';
}

async function browserPolicy(browser: Browser): Promise<Policy | undefined> {
  const [page] = await browser.pages();
  if (page && hasClient(page)) {
    const connection = page._client().connection();
    return connection ? policies.get(connection) : undefined;
  }
  return undefined;
}

export async function getRuntimeMode(browser: Browser): Promise<RuntimeMode> {
  return (await browserPolicy(browser))?.mode ?? 'debug';
}

async function applyMode(policy: Policy, mode: RuntimeMode): Promise<void> {
  policy.mode = mode;
  for (const state of policy.sessions.values()) {
    if (!state.requested || state.session.detached) {
      continue;
    }
    try {
      if (mode === 'stealth') {
        await state.send('Runtime.disable');
        await bridgeFor(policy, state).enable();
      } else {
        await state.bridge?.disable();
        await enableDebug(policy, state);
      }
    } catch (error) {
      if (!state.session.detached) {
        throw error;
      }
    }
  }
}

export async function setRuntimeMode(
  browser: Browser,
  mode: RuntimeMode,
): Promise<void> {
  const policy = await browserPolicy(browser);
  if (!policy) {
    throw new Error('No Chrome Runtime connection is available');
  }
  await using _guard = await policy.mutex.acquire();
  if (policy.mode === mode) {
    return;
  }
  const previous = policy.mode;
  try {
    await applyMode(policy, mode);
  } catch (error) {
    await applyMode(policy, previous).catch(rollbackError => {
      logger?.('Runtime mode rollback failed', rollbackError);
    });
    throw error;
  }
}
