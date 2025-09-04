# Omnitab (Zen/Firefox WebExtension)

Omnitab mirrors tabs across all windows: open a tab in one window and it appears in the others, providing Arc-like shared workspace viewports for multi-monitor workflows.

## Install (temporary add-on)

1. No build required. Load as a temporary add-on.
2. Firefox/Zen: go to `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on..." → select the `manifest.json` in the `extension/` directory.

## Usage

- Opening a new tab in any window will open the same tab in all other windows.
- Closing a tab will close its mirrors in other windows.
- Navigating a tab (URL change) will update its mirrors.
- Switching the active tab attempts to focus mirrors in their windows.

Notes:
- Firefox API limits may prevent perfect focus behaviour in all cases.
- Private windows are skipped and not mirrored.

## Development

The extension is pure WebExtension JS. If you build helper scripts, prefer `uv` for Python tooling; execution is not required for the extension itself.

Directory structure:

```
extension/
  manifest.json
  background.js
```

## Persistence

A lightweight mapping of logical workspace tabs to per-window tab IDs is kept in `browser.storage.session` to avoid stale data across restarts; it is rebuilt on startup.

## Privacy

- No network requests
- No analytics
- Only uses `tabs`, `windows`, `sessions`, and `storage` permissions

## Known limitations

- Pinned tabs may not mirror perfectly due to Firefox rules.
- Private windows are not mirrored by default.

---

MIT Licence
