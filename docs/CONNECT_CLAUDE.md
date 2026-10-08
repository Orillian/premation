# Connect Claude to Premation

Claude can work in your Premation project for you: build compositions, add
layers and text, animate, add effects, cameras and lights — and look at the
frames it made to fix them. You watch it happen in the editor, and you can undo
anything it does.

Claude for Premation is part of the **Premation Pro** plan.

## What you need

- Premation, installed on this computer.
- **Claude Desktop** (free download from claude.ai/download), or Claude Code.

You do not need to install anything else.

## Connect Claude Desktop

1. In Premation open **Settings → AI Engine**, scroll to **Claude for Premation**.
2. Click **Connect Claude**.
3. **Quit Claude Desktop completely and open it again.** (Closing the window is
   not enough — quit it from the tray / menu bar.)
4. Open a project in Premation, then ask Claude, for example:
   *"In Premation, make a 5-second title reveal that says SUMMER SALE."*

Claude asks your permission the first time it uses a Premation tool.

To check everything works, click **Test connection** in the same card. Each step
gets a tick, or says what is wrong.

## Connect Claude Code

In **Claude for Premation**, open *Using Claude Code, or setting it up by hand*,
click **Turn on for Claude Code**, then copy the command shown and run it once in
a terminal.

## While Claude works

- A small **Claude is editing** badge appears at the bottom of the editor. Click
  **Stop** to stop it and throw away what it was in the middle of.
- Each request Claude makes is one step in **Edit → Undo** (it is labelled
  "Claude: …" in the History panel). Press Ctrl+Z / ⌘Z to undo it.
- If you start editing while Claude is in the middle of something, Claude's part
  so far is saved as its own undo step first, so your edit stays yours.

## If something is wrong

| What you see | What to do |
|---|---|
| Claude says *Premation is not open* | Open Premation and a project, then ask again. |
| Claude says *Claude is not set up in Premation* | Click **Connect Claude** in Settings. |
| The card says **Needs repair** | Click **Repair connection**, then restart Claude Desktop. This happens when Premation moved, usually after an update. |
| Claude does not list Premation | Quit and reopen Claude Desktop. |
| Claude says it needs a Pro plan | Upgrade in Premation (Settings → Billing). |
| The card says Claude's config is not valid | Premation will not touch a file it cannot read. Fix the file, or add Premation by hand with the snippet in the card. |

## Turning it off

Click **Disconnect Claude**. Premation removes only its own entry from Claude's
settings — your other Claude connectors stay as they are — and stops accepting
connections. Uninstalling Premation on Windows removes the entry too.

## Privacy

Everything stays on your computer: Claude talks to Premation through a private
local connection, not over the internet, and only Premation's own editing tools
are available — no files, no commands. What Claude sends to its own service is
covered by Anthropic's terms.
