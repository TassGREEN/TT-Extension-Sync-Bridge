# TT Extension Sync Bridge context

The plugin only synchronizes third-party extension settings that TauriTavern does not already cover.

It never reads or writes chats, chat metadata, summaries, message history, image caches, request caches, or task queues.

## Public test seams

- Snapshot seam: create and verify versioned, content-addressed adapter snapshots.
- Adapter seam: capture, preview, and restore one target plugin through a host boundary.
- Store seam: persist snapshots through the TauriTavern Extension Store API.
- Controller seam: orchestrate capture and guarded restore without bypassing conflicts.
- Host seam: access `extension_settings`, localStorage, IndexedDB, manifests, and settings persistence through explicit capabilities.

Tests use synthetic fixtures only. They never load the user's runtime settings or browser databases.
