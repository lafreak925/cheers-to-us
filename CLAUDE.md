# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

A single-page marketing site ("Cheers To Us") whose centrepiece is an
interactive 3D globe built out of user-submitted photos. No build step, no
package manager, no framework install — plain files served statically. React,
ReactDOM and Babel are pulled from unpkg at runtime by `support.js`.

## Running it

```bash
./serve.sh            # http://localhost:8000/index.html  (or ./serve.sh 3000)
```

`index.html` **must** be served over HTTP. It loads `./ImgSphere.jsx` via fetch
and Babel-transpiles it in the browser, and `file://` blocks that. Only
`standalone-offline.html` opens directly from disk.

## Verifying

There is no test suite; the failure modes are visual, so look at the page. A
healthy load logs exactly two `[dc-runtime] x-import` info lines — any other
console output, or any 404, is a regression.

Worth driving a headless browser for, because these have all broken before and
none of them are obvious from reading the code:

- **Globe seams.** Restyle the backdrop to a colour no photo contains
  (`#00ff00`), screenshot across ~10 drag rotations including both poles, and
  count green pixels inside 90% of the disc radius. Any hole in the shell shows
  up as green. Current baseline: **~0.002%**, worst single frame ~0.01%. If a
  change pushes that into tenths of a percent, the geometry regressed.
- **Overflow.** `document.documentElement.scrollWidth === window.innerWidth` at
  390 / 768 / 1280.
- **Keyboard.** Tab to a featured card, Enter opens the modal; Space on Next
  advances; Enter on Close closes; Esc and arrows work from anywhere.
- **Touch.** Vertical swipe on the globe scrolls the page, horizontal spins it,
  a tap opens a moment. Note raw CDP `Input.dispatchTouchEvent` does not
  synthesise a click — use a real tap gesture or you'll chase a phantom bug.
- **The offline bundle**, with all non-`file://` requests aborted.

## Layout of the code

| File | Role |
| --- | --- |
| `index.html` | The page. Markup + copy in the `<x-dc>` block, app logic in the `<script type="text/x-dc">` block at the bottom. |
| `Coke Globe Home.dc.html` | **Byte-identical copy of `index.html`.** Keep it in sync (`cp index.html "Coke Globe Home.dc.html"`). |
| `ImgSphere.jsx` | The globe component. Loaded by `<x-import>`, registered on `window.ImgSphere`. |
| `support.js` | Generated dc runtime. **Do not edit** — it is rebuilt from a separate `dc-runtime` project. |
| `standalone-offline.html` | Generated bundle. **Do not hand-edit** — run `python3 build-standalone.py`. |
| `build-standalone.py` | Rebuilds that bundle from the working files. Deterministic: rebuilding unchanged input gives a byte-identical file. |
| `serve.sh` | Static server on localhost. |
| `wireframes.dc.html` | Earlier home-page wireframe options. Standalone, shares only `support.js`. |
| `photos/pN.png` | 600px originals (modal, featured row). `tN.png` are the 300px facet textures. |
| `logo.png` | Coca-Cola wordmark in the header, keyed out of `full_Res_images/cocaCola.png` and cropped to its ink. Rendered white via a CSS `brightness(0) invert(1)`. |
| `full_Res_images/` | 1280px source photos — **unused by the site**, nothing references them. `cocaCola.png` is the exception: it is the source `logo.png` was derived from, not a photo. |

After changing `index.html`, `ImgSphere.jsx` or `support.js`, run
`python3 build-standalone.py`, or the offline copy silently ships the old code.
The bundle inlines the runtime, React, Babel and the webfonts, but **not** the
photos — `photos/` has to sit next to it.

## The dc template dialect

`index.html` is not plain HTML. Inside `<x-dc>`:

- `{{ name }}` interpolates a value returned from `renderVals()`; it works in
  text, in attributes, and mid-string inside `style="..."`.
- `<sc-for list="{{ xs }}" as="x">`, `<sc-if value="{{ flag }}">` are the
  control flow. `hint-placeholder-count` / `hint-placeholder-val` only affect the
  pre-hydration skeleton.
- `style-hover="..."` compiles to a hover rule.
- `class` maps to `className`. `role`, `tabindex`, `aria-*`, `data-*` and `title`
  pass straight through.
- Camel-cased attributes survive as written here, but the bundler rewrites them
  to `sc-camel-*` (see `CAMEL` in `build-standalone.py`) because DOMParser
  lowercases attribute names. **Add any new camelCase attribute to that list** —
  miss it and the served page works while the offline bundle silently drops the
  handler.
- Logic lives in `class Component extends DCLogic`: `state`, `setState`,
  `componentDidMount`, and `renderVals()` returning the bindings. Event handlers
  are passed as values (`onClick="{{ handler }}"`), so they read their arguments
  off `e.currentTarget.dataset`.

Styling is inline `style="..."` almost everywhere. Responsive rules that inline
styles can't express live in the `<style>` block in `<helmet>` and target tags
and ids (`header`, `nav`, `#globe`, `#stage`, `#regions`, `#stats`, `#stories
.cards`, `#about`) with `!important`. Anything that needs a JS-computed value
instead comes through `renderVals()` (`heroCols`, `sphereSize`, `modalCols`).

## The globe — read before touching `ImgSphere.jsx`

The geometry is subtle and was wrong in an earlier version. The invariant:

> A facet must cover **exactly its lat/long cell as seen from the sphere's
> centre.** Cells tile the sphere, so facets then tile the silhouette.

That is why the facet outline is the cell boundary *projected radially onto the
facet's tangent plane* (`proj()`), not a trapezoid. The longitude edges come out
straight, the latitude edges come out curved, and drawing those latitude edges as
straight chords is what used to leave a wedge-shaped gap at every corner and a
torn pinwheel at each pole.

Grid: `rows` 12 × `cols` 17, ring counts scaled by `cos(lat)` with a `minRing`
floor of 7, radius `size * 0.36`.

Consequences worth keeping in mind:

- `rows` must be even, so the polar bands' outer edge lands exactly on ±90 and
  the facets converge on one shared apex.
- Facet shapes are **SVG alpha masks**, not `clip-path`. A clip on an element
  inside a CSS 3D scene is a hard 1-bit cut with visible stair-steps; masks
  composite through alpha and antialias. Fill them white — `mask-mode` defaults
  to reading alpha, but a luminance reading of black would hide every facet.
- `frame` is the white border around each photo and is now `0` — photos meet
  edge to edge. `bleed` (3px) is independent of it: two abutting antialiased
  edges each land on the same pixel at partial coverage and let the background
  through as a hairline, so every facet is grown past its cell. With no border
  that overlap lands on the neighbour's photo, costing a couple of pixels of
  crop at the seam. If you put a border back, raising `frame` above `bleed`
  makes the overlap land on shared white and the seam settles at `2 * frame`.
- The photo's mask is inset by `frame` and then outset by `bleed`, so at
  `frame = 0` the two cancel and it is exactly the facet's own mask. Inset it
  without that correction and the bleed reappears as a white ring.
- `arc()` samples a curved edge into chords and takes `Math.abs(to - from)` —
  the bottom edge runs right-to-left to close the outline, and without the abs
  it silently collapses to the 3-chord minimum on every facet.
- The component is mounted inside an inline `<span>` by the runtime, so
  `parentElement.clientWidth` is `0`. Walk up past zero-width wrappers when
  measuring the available stage (the zoom clamp does this).
- `touch-action` is `pan-y`, and a touch drag only claims the gesture once it
  proves horizontal. The globe fills most of a phone screen, so `none` here
  means the page can't be scrolled past it. Don't "simplify" that check away —
  and if you do touch work, set `moved` high when handing a gesture back, or
  the release registers as a tap and opens a moment.
- The per-frame loop writes styles directly to DOM nodes via refs and runs the
  depth pass every other frame. Don't convert it to React state.

## Conventions

- Match the surrounding style: inline styles in the HTML, `React.createElement`
  (not JSX syntax) in `ImgSphere.jsx`, comments that explain *why* rather than
  restating the code.
- The photo captions and region labels are real content — don't invent moments,
  countries or provenance for them. Regions with no moments render dimmed and
  inert rather than filtering to an empty globe.
- Clickable elements are `<div role="button">`, so each needs `tabindex` and an
  `onKeyDown` (`this.key(fn)` wraps a click handler for Enter/Space). A div with
  only `onClick` is unreachable by keyboard.
- Don't call `navigator.share` on desktop: browsers there advertise it and then
  never settle the promise, leaving the control with no feedback. It's gated on
  `pointer: coarse`, with the clipboard as the path everywhere else.
- Prefer fixing a dead control over deleting it, and over inventing a
  destination for it.

## Open items

- **`Share a Coke`** (header, previously `Scan a can`) is a campaign CTA with no
  destination. It needs a real target — a share flow or landing page — rather
  than an invented one. It is the only control on the page that does nothing.
- **`full_Res_images/`** is unused. The modal and featured row currently read the
  600px `photos/pN.png`; these 1280px files could replace them, but the mapping
  from filename to moment hasn't been established.
