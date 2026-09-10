# Design

- Extend the authenticated Agent WebSocket with ping request/result messages and capability negotiation. Request IDs are bound to the exact agent socket and machine. Keep SQLite scheduling/history; migrate legacy controller monitors to paused, unassigned records.
- Centralize SSH credential loading, host fingerprint pinning and connection lifetime for terminal, SFTP and approved commands. SFTP uses canonical POSIX paths, bounded files, revision hashes, conflict detection, backups and atomic rename where supported.
- Add an administrator-only workspace router for files, shortcuts, AI configuration/runs, proposed changes and command approvals. AI sees only explicitly selected workspace files and read-only tools; writes and shell commands remain proposals until approved.
- Use the existing dark operational UI and typefaces, with charcoal tool surfaces, cyan actions, green success and red failures. Full-width workspace with terminal/files/AI tabs and a compact sidebar; no marketing content. CodeMirror supplies syntax highlighting, search, undo and file diffs. Lucide supplies tool icons.
- Revoke sessions on credential changes, revalidate roles against the database, remove JWT query parameters from browser WebSockets, verify origins and host keys, and bound socket/HTTP/model/file buffers.
- Verify Node integration tests using a local SSH/SFTP fixture and fake compatible model API, Go agent tests, TypeScript, production builds and browser desktop/mobile workflows.
