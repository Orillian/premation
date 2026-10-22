# Scripting

Premation runs After Effects-style scripts: plain JavaScript files (`.jsx` or
`.js`) that read and change the open project through AE's `app.project`
object model, or through Premation's engine API directly.

## Running a script

- **File ▸ Scripts ▸ Run Script File…** — pick a `.jsx` / `.js` file anywhere
  and run it.
- **File ▸ Scripts ▸ _a script_** — every `.jsx` / `.js` file in the Scripts
  folder is listed at the bottom of the submenu and runs on click. The list is
  rescanned when the menu opens and when the window regains focus.
- **File ▸ Scripts ▸ Open Scripts Folder** — opens the folder in Explorer /
  Finder (created the first time). It is `Scripts` inside the app's user data
  folder:
  - Windows: `%APPDATA%\Premation\Scripts`
  - macOS: `~/Library/Application Support/Premation/Scripts`
- **File ▸ Scripts ▸ Open Script Editor** (also in the command palette as
  "Script Editor") — a panel to write, open, save and run scripts:
  - **Run** or **Ctrl+Enter** (Cmd+Enter on macOS) runs the buffer;
  - **Tab** inserts two spaces, **Shift+Tab** outdents the line;
  - the folder button opens a script, the save button saves it (to the file it
    came from, or into the Scripts folder for a new one; Shift-click for Save
    As…);
  - the console shows `$.writeln`, `alert` and `premation.log` output, the
    script's return value, and an error with the line it happened on (that line
    is also marked in the gutter).

Every run is **one undo step** named `Script: <name>`. A script that throws, or
whose engine command is refused and not caught, changes nothing: the whole run
is rolled back. A run is stopped after 30 seconds.

## Permissions

Before a script runs, Premation asks: the dialog names the script and what it
wants — **Read the project** and/or **Change the project** — with **Allow Once**
and **Cancel**. Nothing is remembered; every run asks.

A script can declare what it needs in its first 20 lines:

```js
// @permissions document.read
```

`document.read` lets it query the project; `document.write` lets it change it.
A script with no header (every After Effects script) is asked for both when it
is run from the editor.

Scripts run in a sandboxed worker: no files, no network, no DOM, no storage.
They reach the project only through `app` and `premation`, and can never undo,
save, open projects or drive the transport.

## The `app` object model (an After Effects subset)

```js
var comp = app.project.activeItem;
if (!(comp instanceof CompItem)) throw new Error("Open a composition first.");

app.beginUndoGroup("Make a rig");          // accepted; a run is one undo step anyway
var bg = comp.layers.addSolid([0.1, 0.1, 0.12], "Background", comp.width, comp.height, 1);
var title = comp.layers.addText("Hello");
title.property("Transform").property("Position").setValue([960, 540]);
title.transform.opacity.setValueAtTime(0, 0);
title.transform.opacity.setValueAtTime(1, 100);
title.transform.rotation.expression = "wiggle(2, 10)";
var rig = comp.layers.addNull();
rig.name = "Rig";
title.parent = rig;
app.endUndoGroup();

$.writeln(comp.name + " now has " + comp.numLayers + " layers");
```

Scripts are written **synchronously**, as in After Effects — no `await` needed
for `app`.

### Project

| Member | Notes |
| --- | --- |
| `app.project.activeItem` | The composition open in the editor, or `null`. |
| `app.project.items`, `items[i]`, `app.project.item(i)` | 1-based, all project items (compositions, footage, folders). `items.length`. |
| `app.project.numItems` | |
| `app.project.items.addComp(name, width, height, pixelAspect, duration, frameRate)` | Also `app.project.addComp(…)`. Duration in seconds; 29.97 / 23.976 / 59.94 become exact NTSC rates. |
| `app.project.items.addFolder(name)` | |
| `app.project.compositions` | Premation extra: every `CompItem`. |

### Items

`Item`: `id`, `name` (get/set), `comment`, `parentFolder`, `typeName`, `remove()`.
`FolderItem`: `items`, `numItems`, `item(i)`. `FootageItem`: `width`, `height`,
`duration`, `frameRate`.

`CompItem`: `name`, `width`, `height`, `pixelAspect`, `duration`, `frameRate`
(all get/set), `frameDuration`, `bgColor` (get/set `[r, g, b]`), `workAreaStart`,
`workAreaDuration`, `time` (the editor's current time when the run started),
`numLayers`, `layer(index | name)`, `layers` (`layers[i]`, `layers.length`,
`layers.byName(name)`), `duplicate()`. `selectedLayers` is always empty (the
selection is editor state, not part of the project).

`comp.layers.addSolid(color, name, width, height, pixelAspect[, duration])`,
`addText([text | TextDocument])`, `addNull([duration])`, `addShape()`,
`addCamera(name)`, `addLight(name)`, `add(item[, duration])` (footage or a
composition as a layer). New layers go on top, as in AE.

### Layers

`Layer` (and `AVLayer`, `TextLayer`, `ShapeLayer`, `CameraLayer`, `LightLayer`
for `instanceof`): `id`, `name` (get/set), `index` (1 = top), `containingComp`,
`comment`, `inPoint` / `outPoint` / `startTime` (seconds, get/set), `stretch`
(percent), `enabled`, `solo`, `locked`, `shy`, `threeDLayer`, `motionBlur`,
`adjustmentLayer`, `label`, `nullLayer`, `parent` (get/set; keeps the layer
where it is on screen, like AE's pick whip; `setParentWithJump(layer)` does
not), `remove()`, `duplicate()`, `moveToBeginning()`, `moveToEnd()`,
`moveBefore(layer)`, `moveAfter(layer)`.

Properties: `layer.property("Transform").property("Position")`, match names
(`"ADBE Transform Group"`, `"ADBE Position"`, `"ADBE Rotate Z"`, …), indices
(`property(1)`), and the shortcuts `layer.transform.position`,
`layer.position`, `layer.anchorPoint`, `layer.scale`, `layer.rotation`,
`layer.opacity`, `textLayer.sourceText` / `textLayer.text.sourceText`,
`layer.effect("Name")`. Any other group the layer has (effects, masks, shape
contents, text options, materials, …) is reached by its name through
`property(…)`.

### Properties

`Property`: `name`, `matchName`, `value` (at the editor's current time, after
expressions), `valueAtTime(t[, preExpression])`, `setValue(v)`,
`setValueAtTime(t, v)`, `setValuesAtTimes(times, values)`, `numKeys`,
`keyTime(i)`, `keyValue(i)`, `nearestKeyIndex(t)`, `addKey(t)` (returns the
key's index), `removeKey(i)`, `setValueAtKey(i, v)`, `expression` (get/set —
setting one also enables it, `""` removes it), `expressionEnabled` (get/set),
`expressionError`, `isTimeVarying`, `canSetExpression`, `dimensions`,
`valueType` (Premation extra). `PropertyGroup`: `numProperties`,
`property(…)`, `parentProperty`.

Values are AE's: numbers, arrays for vectors (`[x, y]`, `[x, y, z]` — a 2D
layer takes `[x, y]` and ignores a `z`), colours as `[r, g, b, a]` in 0–1,
Source Text as a `TextDocument` (`new TextDocument("Hi")`, `.text`; `fontSize`
and `font` are applied when set), paths as `Shape` (`vertices`,
`inTangents`, `outTangents`, `closed`). Times are seconds.

### Helpers

`alert(msg)` and `$.writeln(…)` / `$.write(…)` print to the console.
`confirm(msg)` prints and answers OK; `prompt(msg, default)` prints and answers
the default (there is no modal UI in the sandbox). `app.beginUndoGroup` /
`endUndoGroup` / `beginSuppressDialogs` / `endSuppressDialogs` are accepted
and ignored. A script may `return` a value; it is shown in the console.

## The `premation` API

The engine API itself, asynchronous — the same commands and queries the UI,
the AI tools and plugins use (docs/ENGINE_API.md):

```js
// @permissions document.read, document.write
const doc = await premation.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
const { layer } = await premation.execute({ type: 'createLayer', comp: doc.comps[0].id, kind: 'null', name: 'Rig', init: [] });
await premation.execute({ type: 'setProperty', prop: { layer, path: 'transform/rotation' }, value: { kind: 'scalar', value: 45 } });
premation.log('made', layer);
```

`execute(command)`, `batch(label, commands)`, `query(query)`,
`onEvents(listener)`, `log(…)`, `seconds(s)` (seconds → API time),
`permissions`. A refused command throws an error with `code` (`notFound`,
`invalidArgument`, …). `app` and `premation` can be mixed in one script as
long as each `premation` call is awaited before the next engine call.

## Differences from ExtendScript

- **A subset.** Only the members listed above exist. Render queue, footage
  interpretation, markers, masks and effects as typed objects, keyframe
  interpolation and ease, `app.settings`, `app.executeCommand` and project
  open / save are not available (the last throw a clear error).
- **No `File`, `Folder`, `Socket`, `system.callSystem`, `#include`** (the
  sandbox has no file or network access). `#target` / `#include` lines are
  ignored rather than failing the parse. `.jsxbin` cannot run.
- **No ScriptUI.** Panels (`ScriptUI Panels`), `Window`, `dialog` do not
  exist; `alert` / `confirm` / `prompt` print to the console.
- **Modern JavaScript.** Scripts run on a current JavaScript engine (ES2022+):
  `let`, arrow functions, `Array.prototype.map`, `JSON` all work; ExtendScript
  quirks (`.toSource()`, XML literals, operator overloading) do not.
- **How a synchronous script reaches an asynchronous engine.** The script runs
  in a worker; each read the engine has not answered yet ends the current pass,
  is answered, and the script runs again from the top with the earlier answers
  served from memory (writes are sent once, in order, never repeated). This is
  invisible to a normal script, with three consequences:
  - code between engine calls runs once per pass — keep slow pure computation
    out of loops that also read the project, and avoid side effects other than
    `app` / `premation` / the print helpers (they are the only ones replayed
    exactly once);
  - `Math.random()` and `Date.now()` / `new Date()` are fixed per run so every
    pass agrees (a run sees one "now");
  - a script making tens of thousands of separate reads is stopped.
- **The selection and the playhead are not project state.** `selectedLayers`
  is empty; `comp.time` is the editor's time when the run started.
- **One undo step per run**, whatever the script does with undo groups; a
  failed run is fully rolled back (AE keeps what ran before the error).
- **Layer parenting** keeps the child where it is (AE's pick-whip behaviour);
  so after `layer.parent = nul` the child's Position reads relative to the
  parent.
- `addShape()` creates Premation's shape layer (a rectangle primitive), not an
  empty shape layer.
