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
  up as green. Current baseline on the 12×24 grid: **0.000%** across 16 frames.
  If a change pushes that into tenths of a percent, the geometry regressed.
  Two traps when scripting this against Chrome over CDP: `Page.captureScreenshot`'s
  `clip` is in **page** coordinates while `getBoundingClientRect` is
  viewport-relative — mixing them silently shifts the measurement window by
  `scrollY` and reports double-digit percentages that aren't real. And `Input`
  events *are* viewport-relative, so the globe has to be scrolled on-screen or
  every synthetic drag misses and each frame comes back identical.
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
| `photos/pN.webp` | 900px, quality 84 — what the modal and the featured row open. `tN.webp` are the 300px facet textures the globe wears. 58 of each. `BASE` carries the filename **with** its extension, so a mixed set needs no code change. |
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

Header and footer sit on the red field with no surface of their own — a white
bar and a white footer card were both tried and reverted. Below 900px the nav
collapses into `#burger` and a panel. Watch the inline-style trap there: the nav
carries an inline `display:flex`, so the responsive rules that hide it need
`!important`, and without that the links stay in the bar and shove the CTA past
the right edge, where the wrapper's clipping hides it instead of reporting it.

The rising bubbles are `#fizz`, a decorative layer behind the content: markup in
the `<x-dc>` block, placement from `makeBubbles()` in `renderVals`, animation in
the `<helmet>` style block. Keep them **transform/opacity only** — the globe
already owns the main thread, and anything that forces layout or paint per frame
there is felt immediately on a phone. They are hidden outright under
`prefers-reduced-motion` rather than duration-clamped, which would strobe them.

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

Grid: `rows` 12 × `cols` 24, ring counts scaled by `cos(lat)` with a `minRing`
floor of 7, radius `size * 0.44`. `cols` is twice `rows` on purpose: the bands
are `180 / rows` tall and the equatorial cells `360 / cols` wide, so the two
match and the cells come out square. Change one without the other and the photos
render as letterboxed strips. Rows are not staggered, so cell edges line up
across bands that share a ring count and the grid reads as one lattice.

Consequences worth keeping in mind:

- `rows` must be even, so the polar bands' outer edge lands exactly on ±90 and
  the facets converge on one shared apex.
- Facet shapes are **SVG alpha masks**, not `clip-path`. A clip on an element
  inside a CSS 3D scene is a hard 1-bit cut with visible stair-steps; masks
  composite through alpha and antialias. Fill them white — `mask-mode` defaults
  to reading alpha, but a luminance reading of black would hide every facet.
- `frame` is the white border around each photo and is `2`, so neighbours are
  separated by a `2 * frame` hairline. `bleed` (1.2px) is the overlap that stops
  two abutting antialiased edges from letting the background through as a
  hairline of their own. **`frame` has to stay above `bleed`** or the photo's
  outset swallows the border and no white shows at all. Lowering `bleed` is the
  change most likely to bring seams back — re-run the green-backdrop check after.
- Both are applied by **offsetting the finished outline along its own normal**
  (`offset()`), not by shifting the cell's lat/long bounds: on a curved latitude
  edge an angular inset is not an even px distance, so the border came out
  thicker at the corners than in the middle. The photo's mask is the same
  outline at `bleed - frame`.
- The facets were briefly cut as interlocking jigsaw pieces. If that ever comes
  back: a tab is only safe where the neighbour carries the matching socket, which
  means longitude edges only. Bands don't line up — ring counts run 7, 9, 15 … 24
  — so a latitude tab has nothing to mate with and its socket opens a hole.
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
- Phones get a smaller globe in three ways, all keyed off `size < 520`: 8 rows
  rather than 12 (6 if `hardwareConcurrency`/`deviceMemory` report a lean
  device), the depth pass every third frame, and **no per-facet CSS filter** —
  each filter is a compositing pass, and 86 of them a frame is what made this
  unusable. Depth there rests on the back-face fade alone.
- **Phones don't run the loop at all while idle.** The rotation is one CSS
  keyframe animation (`imgsphere-spin`) on the inner container, so the browser
  turns the globe on the compositor and no script runs per frame. `down` takes
  it back — `detachSpin()` freezes it at the angle the animation had reached,
  computed from elapsed time rather than read back out of a matrix — and the
  loop then carries the drag. Release hands it over again, with a negative
  `animation-delay` so it resumes from where the drag left it.
- Release hands back **directly in the `up` handler** when there is no momentum,
  not on the next frame. Waiting for a frame means a throttled rAF leaves the
  globe sitting still for as long as the throttle lasts.
- There is deliberately **no IntersectionObserver** pausing the loop. It was
  tried: when the callback doesn't arrive the globe simply never moves, and the
  failure is silent. Browsers already throttle off-screen CSS animations.
- Phones also get a static lighting overlay — one element, a highlight and a
  rim shadow — because with no per-facet brightness the grid otherwise reads as
  a flat mosaic rather than a sphere.

## Conventions

- Match the surrounding style: inline styles in the HTML, `React.createElement`
  (not JSX syntax) in `ImgSphere.jsx`, comments that explain *why* rather than
  restating the code.
- The photo captions and region labels are real content — don't invent moments,
  places or provenance for them. Regions with no moments render dimmed and
  inert rather than filtering to an empty globe.
- **The site is India-only.** `REGIONS` is the five Indian zones plus `ALL`
  (`"All India"`), the unfiltered sentinel that `shown()`, the counts and
  `pickRegion` all test against — it is deliberately not a value any photo
  carries. No continent, country or "world" framing in the copy.
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
