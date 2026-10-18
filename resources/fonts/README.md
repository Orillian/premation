# Bundled fonts

The faces the engine registers before any installed font
(`PREMATION_FONTS_MANIFEST` → `fonts.json` here; `electron/engineHost.ts` sets
it, `electron-builder.yml` ships this folder to `<resources>/fonts`).

Why: a family that is not installed renders in a fallback face, so text looked
different on every machine — the default `Inter` was not installed on the
owner's PC, and Japanese named in an uninstalled family came out as boxes
(docs/PROGRAM_PLAYBACK_TEXT_INK.md, T1/T2).

`node scripts/fetchFonts.cjs` downloads the families (all SIL Open Font
License 1.1, license files kept beside them) and regenerates `fonts.json`:

| family | why |
|---|---|
| Inter | the editor's default text face |
| Noto Sans / Noto Serif | Latin, Cyrillic, Greek fallback with a matching serif |
| Noto Sans JP / Noto Serif JP | Japanese (Mincho-style serif for titles) |
| Noto Sans SC / Noto Sans TC | Simplified / Traditional Chinese |
| Noto Sans KR | Korean |
| Noto Sans Devanagari / Thai / Arabic / Hebrew | the complex scripts |

These faces are marked fallbacks (`"fallback": true`): a character the requested
family does not have is drawn from these, in this order, before the OS is asked.

The design families the font menu offers ship too, so a project that uses them
renders the same on every machine, in the viewport and in exports: Roboto, Open
Sans, Montserrat, Outfit, Playfair Display, Lora, Merriweather, Fira Code, PT
Sans, Oswald, Raleway, DM Sans, Space Grotesk, Bebas Neue, Anton, Poppins. They
are never fallbacks.

A variable file is registered once (at its default weight) and stands for its
whole `wght` range: the engine draws a requested weight on the axis, and the
optical size at the font size. Each face's `axes` (read from its `fvar` by the
script) is what the font menu offers — `src/core/fonts/engineFontList.ts`.
