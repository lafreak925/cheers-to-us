# Cheers To Us — interactive photo-globe home page

## Run it
- `./serve.sh` — serves the folder and opens http://localhost:8000/index.html. Pass a port to change it (`./serve.sh 3000`). Equivalent to `python3 -m http.server`.
- `index.html` needs a server: it loads `./ImgSphere.jsx` over fetch, which a `file://` page is not allowed to do.
- `standalone-offline.html` — double-clickable copy. The dc runtime, React, Babel and the webfonts are inlined, so it opens straight from disk with no server and no network. Keep the `photos/` folder next to it; the photos are not inlined.
- `wireframes.dc.html` — the earlier home-page wireframe options (1a / 1b / 1c).

## Files
- `index.html` / `Coke Globe Home.dc.html` — identical copies: page markup, copy, and the story/region logic.
- `ImgSphere.jsx` — the interactive globe: exact spherical-cell facets, drag + momentum + auto-rotate, wheel zoom (clamped), depth shading, click-to-open.
- `support.js` — the dc runtime that renders the page. Generated; don't edit.
- `build-standalone.py` — regenerates `standalone-offline.html`. **Run it after any change to `index.html`, `ImgSphere.jsx` or `support.js`**, or the offline copy silently goes stale.
- `photos/tN.webp` — 300px facet textures used on the globe. `photos/pN.webp` — 900px versions for the modal and featured row. 58 photos, 5.6 MB in total.

## Editing
- Photos and captions: the `BASE` list at the top of the logic block in `index.html`. Add a `pN` + `tN` pair and a row to `BASE`, naming the file with its extension. Derivatives are made with `cwebp -q 84 -resize 900 0` and `-q 78 -resize 300 0`. Copy `index.html` over `Coke Globe Home.dc.html` to keep the two in sync, then rebuild the standalone.
- Globe density: `rows` / `cols` in `ImgSphere.jsx` (currently 12 × 17). `rows` must stay even so the top band's edge lands exactly on the pole.
- Size: `sphereSize` in the logic block (default 660px, shrinks to fit the stage and the viewport height).
- Zoom limit: the `maxZoom` line in `ImgSphere.jsx`.

## How the globe stays seamless
Each photo is a flat facet laid tangent to the sphere, covering exactly one cell
of a lat/long grid. The facet outline is that cell's boundary projected radially
onto the facet's own plane, so the longitude edges are straight and the latitude
edges are curved. Cells tile the sphere, so the facets tile the silhouette with
no gaps — including at the poles, where the bands taper to a shared apex. The
shapes are SVG alpha masks rather than `clip-path`, because a clip inside a CSS
3D scene is a hard, unantialiased cut; facets also overlap by 3px (`bleed`) so
abutting antialiased edges don't leave a hairline.

`frame` in `ImgSphere.jsx` is the thin white border around each photo (2px, so a
4px hairline between neighbours); it has to stay above `bleed` or the photo's
outset swallows it. See the comments there.
