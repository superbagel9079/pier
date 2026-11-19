<!-- Part of Pier's documentation: see the index in ../README.md -->
# Design

Reading this as: a desktop operator console for developers who drive Pi on a VM, in Pier's 1-bit console language, with one identity motif, the pi mark drawn as ordered-dither ASCII. Dial: ENERGY 1, RHYTHM 1, MOTION 2: quiet, regular, and moving only for what the user does.

## The language

- **Two tones and the steps between them.** A theme gives `bg` and `fg`; the panels, fields, the row under the pointer and the surfaces are mixes of the two (`style.css`: `--surface` 5%, `--raise` 10%, `--strong` 16%). `completeTheme` in `themes.js` derives what a theme leaves out.
- **Square.** No radius anywhere.
- **Mono.** Cascadia Mono, then Consolas, `ui-monospace`, `monospace`; 11, 12, 13 and 15 px.
- **Spacing on a 4 px step:** 4, 8, 12, 16, 24 (`--s1` to `--s5`).
- **A line between rows**, not a card around each.
- **One accent**, the theme's (the text colour in Pier's own themes), for the focus ring, the active tab and the palette's chosen row. Nothing else uses it.

## The motif: the pi mark, dithered

- **What.** The 10 by 10 grid of `client/icon-source.png` (`PIER_MARK` in `js/dither.js`). Each cell is drawn as `cols` by `rows` characters of the ramp ` .:+#`, chosen by a 4 by 4 Bayer matrix over a soft light from the top left: the ordered dither of a 1-bit screen, in text.
- **Where, and only there.** The connect screens, in `fg`, filled in once in 600 ms; the empty centre dock, in `dim`, still.
- **Never** behind text, over images or video, as a loader, a bullet or a divider.
- **Hidden from screen readers** (`aria-hidden`): it says nothing a reader needs.
- **Short windows.** At 640 px of height or less the connect screens leave it out: the form comes first.

## Motion

| What | How | How long |
|---|---|---|
| A button pressed | scales to .97 | 100 ms |
| A menu, a toast | from opacity 0 and scale .95 | 150 ms |
| The palette | the same | 180 ms |
| A dialog | the same | 200 ms |
| The mark | the dither filling in | 600 ms, once |

- Closing is instant.
- Nothing ambient: no pulse, no shimmer, nothing that moves for more than 5 s (WCAG 2.2.2). A working Pi is a bright bar and the word "working".
- With reduced motion, none of it: the mark is drawn whole.

## The accessibility floor

- **Contrast.** Text 4.5:1, a theme's own and dim text alike, on every surface it is drawn on, the diff's tints included; the accent and the edges of fields 3:1. `completeTheme` makes every theme meet it, imported ones too; `client/test/themes.test.js` checks the built-in ones.
- **Focus.** A 2 px accent ring, 2 px out. Tabs, checkboxes and the window buttons keep their 1 px ring, as they sit edge to edge.
- **Dialogs.** Modal for the keyboard (`trapDialog` in `js/core.js`): Tab stays inside, Escape closes, the focus goes back where it was. The palette does not open over one.
- **Names.** Every field has one: its label, or an `aria-label` where the placeholder is the visible label of a one-field search box.
- **Pointer.** A hand on what can be clicked, not-allowed on what is disabled, set once in a base layer of `style.css`.
- **Keyboard.** The splitters between the docks take the arrows (16 px; with Shift, 64); Enter, or a double click, puts the default width back.
- **Size.** Ctrl+= and Ctrl+- zoom all of Pier. A control is at least 24 px wide or tall, a splitter grabbed 12 px wide.
- **Said aloud.** Errors are `role="alert"`, the connection's status `aria-live`; colour alone never carries a meaning (an error is a bar and bold text).
