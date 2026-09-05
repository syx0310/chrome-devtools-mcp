# Persistent fingerprints

Stealth mode uses Apify `fingerprint-generator` to sample a desktop Chrome device
profile for the controlled browser's operating system. Chrome's actual version,
platform, locale and native User-Agent Client Hints remain authoritative. This
also works when the MCP process and a connected browser run on different systems.
Mobile Chrome connections, including Android debugging, require `--no-stealth`.

The profile supplies screen size, device scale factor and hardware concurrency.
GPU/WebGPU rendering, fonts, Canvas, audio, PDF plugins, permissions, timers and
console behavior retain their native implementations. A generated profile does
not emulate a different operating system or replace the browser's rendering engine.

## Reset from a terminal

Run the server binary with a one-shot option:

```sh
chrome-devtools-mcp --reset-fingerprint
```

This prints the new revision and state-file path, then exits. It starts neither
Chrome nor an MCP server. You do not need to restart your MCP client.

For an explicit profile location, use the same option in the MCP configuration
and the reset command:

```sh
chrome-devtools-mcp --fingerprint-file /path/to/fingerprint.json
chrome-devtools-mcp --reset-fingerprint --fingerprint-file /path/to/fingerprint.json
```

The default state file is `~/.cache/chrome-devtools-mcp/fingerprint.json`.
`CHROME_DEVTOOLS_MCP_FINGERPRINT_FILE` can override the default; an explicit
`--fingerprint-file` takes precedence. Relative paths resolve against the process's
working directory, so absolute paths are preferable in MCP configurations.

Initialization reads the browser's native Client Hints in a temporary private
context at `https://fingerprint.invalid/`. The document is intercepted locally;
no request is sent to that hostname. If you configure `--allowed-url-pattern`,
include `https://fingerprint.invalid/*` so this calibration document is allowed.

## When a reset takes effect

- A running server notices the reset on the next `new_page` call without an
  existing `isolatedContext` name. It creates a new browser context with the new
  profile and returns the new page ID.
- Existing pages and their workers keep their profile, including after a reload.
- Reusing an existing named `isolatedContext` continues that session. Use a new
  name to create a session with the current fingerprint revision.
- The new context starts with fresh cookies and storage. Existing contexts are
  left open, and their login state is retained there.
- With an externally connected Chrome, new MCP-created contexts use the profile;
  pre-existing personal tabs are not retroactively rewritten.

Use the returned `pageId` for subsequent page-scoped tools. Changing the revision
does not change every browser attribute: the real Chrome version, operating
system, locale and graphics capabilities remain stable.

The state file contains a revision. Generated profiles are stored alongside it in
`fingerprint.json.profiles/`, keyed by revision and browser capabilities. Profiles
are reused across restarts, and concurrent processes publish complete files
atomically. Resetting state does not overwrite profiles still used by old sessions.

`--no-stealth` disables fingerprint injection. The legacy
`--anti-devtools-detection` option is disabled by default and only requests debugger
pause suppression. It does not intercept timers, rewrite console messages, fake
permissions or clear application callbacks.

Fingerprint consistency does not hide every DevTools Protocol signal. Public
detectors can still identify an instrumented browser through CDP or timing
behavior, even when UA, Client Hints and worker values agree.

## Reduce Runtime observation

To avoid persistent Runtime subscriptions, start the MCP server with:

```sh
chrome-devtools-mcp --experimental-stealth-runtime
```

This experimental mode discovers execution contexts through temporary bindings
and keeps native page APIs intact. It supports navigation, frames, workers,
script evaluation and fingerprint reset. Console collection uses text summaries
with limited source locations; it cannot retain live object handles, full
exception metadata or complete stacks.

Use the `set_runtime_mode` MCP tool with `{"mode":"debug"}` before reproducing a
problem that requires detailed console objects, exception metadata or deeper
DevTools analysis. Return with `{"mode":"stealth"}`. The switch applies to
MCP-owned sessions in the current browser and does not reset fingerprint state,
cookies or storage. Earlier log details cannot be recovered. Reload existing
pages to start a fresh detection measurement after switching back.

The default remains detailed Runtime debugging. In fingerprint stealth mode,
automatic Runtime stack capture is limited to ten frames to avoid extra work
that grows with application call depth. The page's own `Error.stackTraceLimit`
and custom stack formatters remain under application control.

Independent DevTools clients and tools that start their own debugging sessions,
including Lighthouse, can expose CDP signals while active. Passing a public
detector does not establish invisibility to every detector.

## Development verification

```sh
npm run test tests/fingerprint.test.ts
npm run test tests/stealth.test.ts
npm run test tests/e2e/fingerprint-reset.test.ts
npm run test
npm run test:notices
```

The tests cover platform constraints, persistence and concurrent reset behavior,
UA/Client-Hints agreement, frames, worker types, native API contracts and resetting
an active MCP connection from a separate CLI process. The packaged build includes
the Apify model data files for offline generation.
