# Roblox Friend Manager

A Chrome/Edge extension for bulk-accepting friend requests and bulk-unfriending on
Roblox.

## Installing

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder (`roblox-friend-manager`).
4. Pin the extension so the icon is visible.

## Using it

The extension never reads, copies or stores your `.ROBLOSECURITY` cookie. It uses the same session that's already there.<br/>
Keep a roblox.com tab open; depending on your Chrome version it may need one.

- **Accept all friend requests** - accepts everyone waiting, paced.
- **Unfriend everyone** - scans your friends list first, shows *"remove N, keep M"*,
  and waits for you to confirm before removing anything.
- **Stop** - halts immediately. Progress is checkpointed, so restarting picks up
  where it left off rather than starting over.

Set up the **keep-list** first, from Settings. It loads your friends list
automatically; tick anyone who should survive the post-stream cleanup and it saves
as you go. People who aren't current friends can be added by username and show up
in the same list with a "not a friend" tag.

## Tuning

Settings → **Pacing**. If you see rate-limit pauses in the log, raise the starting
delay. If runs feel slow and the log is clean, lower the floor. The extension
adapts within those bounds on its own.

---

Made with ❤️ by [Parritz](https://github.com/parritz/)