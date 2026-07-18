# WArish

WArish is a Windows-first, local-first WhatsApp desktop client built with Electron, React, TypeScript, SQLite, and Baileys. It is structured so that contacts and conversations can become the foundation of a CRM later without coupling the current UI to CRM concepts.

> WArish uses WhatsApp's undocumented linked-device protocol through Baileys. It is not affiliated with or supported by WhatsApp/Meta. Protocol changes can break connectivity, and using unofficial clients may carry account risk. Develop with a dedicated test number and do not automate unsolicited messaging.

## Current feature set

- Link one WhatsApp account by QR code or phone-number pairing code
- User-selected history sync window (1 day, 1 week, or custom days) with full-text search
- On-demand 50-message history pages after the selected initial window is exhausted
- Direct and group conversations
- Text, image, video, document, audio, voice-note, and sticker sending
- Replies, reactions, forwarding, editing, deletion, and read receipts
- On-demand encrypted-source media downloads with a configurable LRU-style cache
- Windows notifications, system tray, close-to-tray, optional startup, light/dark/black themes, and comfortable/compact layouts
- Per-chat text and attachment drafts with explicit retry for failed outgoing messages
- Encrypted Baileys credentials and raw message envelopes using a Windows DPAPI-protected master key

Calls, Status/Channels, Communities, broadcasts, multi-account support, and CRM workflows are intentionally outside this first release.

## Architecture

```text
React renderer (sandboxed)
        │ typed IPC through preload
Electron main ── Windows tray / notifications / secureStorage / file dialogs
        │ MessagePort
Utility process ── Baileys ── WhatsApp linked-device connection
        ├── node:sqlite (WAL, FTS5)
        └── encrypted auth + smart media cache
```

The Baileys/SQLite core runs outside the renderer, and the renderer has no Node.js access. This keeps protocol state and credentials out of the web UI and gives the future CRM a stable RPC boundary.

## Development

Use native Windows PowerShell or Command Prompt. Node `22.12.0` or newer is supported for development; `.node-version` pins Node `24.18.0` for reproducible CI builds. The packaged application uses Electron's embedded Node runtime for SQLite.

```powershell
npm install
npm run dev
```

Useful checks:

```powershell
npm run typecheck
npm test
npm run lint
npm run build
```

Create the Windows NSIS installer with:

```powershell
npm run package:win
```

Application data is stored under Electron's `userData` directory. The selected history window limits the initial import; older pages explicitly requested from a chat remain available locally. Unlinking can retain local history, while **Full fresh reset** removes the account database, encryption key, media, drafts, backups, logs, and preferences before relaunching into onboarding. Downloaded media can be cleared independently from Settings.

## Production notes

- Pin Baileys and test upgrades with a secondary number before release. The dependency is deliberately pinned to an exact release candidate.
- Add a signed `.ico` and Windows code-signing configuration before distributing installers.
- Back up the application data before schema migrations once real accounts are used.
- Review WhatsApp's terms and applicable privacy/data-retention requirements before exposing this to other users.
