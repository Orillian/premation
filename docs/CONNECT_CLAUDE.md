# Connect Claude to Premation

Claude can work in your Premation project for you: build compositions, add
layers and text, animate, add effects, cameras and lights — and look at the
frames it made to fix them. You watch it happen in the editor, and you can undo
anything it does.

Claude for Premation works with any Premation account, Free included (sign in
first).

## What you need

- Premation, installed on this computer.
- **Claude Desktop** (free download from claude.ai/download), or Claude Code.

You do not need to install anything else.

## Connect Claude Desktop

1. In Premation open **Settings → AI Engine** and find **Claude for Premation**.
2. Click **Connect Claude**. Claude Desktop opens its install screen showing
   Premation's logo — click **Install**. The card ticks step 1 by itself.
3. Open Claude Desktop (a new chat). Step 2 ticks when Claude connects.
4. Ask Claude, for example:
   *"In Premation, make a 10-second logo reveal for NOVA with a glow."*
   No project open? Claude creates one.

Claude asks your permission the first time it uses a Premation tool. In Claude
Desktop's **+** menu you will also find ready-made Premation workflows (logo
reveal, kinetic typography, product promo, vertical clip, polish).

## Connect Claude Code

In **Claude for Premation**, open *Using Claude Code, or setting it up by hand*,
click **Turn on for Claude Code**, then copy the command shown and run it once in
a terminal.

## While Claude works

- The **Claude** pill in the title bar shows its state (Ready, Connected,
  Working, Needs you). Click it for what Claude is doing, its recent steps,
  **Stop**, and **Undo Claude's last change**.
- In the editor a badge names the current step. Click **Stop** to stop Claude
  and throw away what it was in the middle of.
- Claude asks before importing files or rendering a video: **Allow** or
  **Deny** in the badge or the pill's panel.
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
| Claude says to sign in | Sign in to Premation, then ask again. |
| The card says Claude's config is not valid | Premation will not touch a file it cannot read. Fix the file, or add Premation by hand with the snippet in the card. |

## Turning it off

Click **Disconnect**. Premation stops accepting Claude. To remove Premation from
Claude as well: Claude Desktop → Settings → Extensions → Premation → Uninstall.
(If you set it up through Claude's settings file under Advanced, Disconnect and
uninstalling Premation remove that entry for you.)

## Privacy

Everything stays on your computer: Claude talks to Premation through a private
local connection, not over the internet, and only Premation's own editing tools
are available — no files, no commands. What Claude sends to its own service is
covered by Anthropic's terms.
