const { useRef, useEffect, useCallback, useMemo } = React;

const D2R = Math.PI / 180;

// Facet shape as an SVG alpha mask rather than a clip-path.
// clip-path on an element inside a 3D scene is a hard 1-bit cut in Chrome and
// Safari, so every slanted facet edge came out as a stair-stepped sawtooth.
// A mask composites through alpha, so the same edge is antialiased.
// White, not black: mask-mode defaults to match-source, which reads an image's
// alpha — but a browser reading luminance instead would hide every facet. White
// is opaque under either reading.
function polyMask(points) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none">' +
    '<polygon points="' + points + '" fill="#fff"/></svg>';
  return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
}

// Interactive 3D photo globe: photos laid out as flat facets tangent to a true
// sphere, on a latitude/longitude grid. CSS 3D preserve-3d, drag + momentum +
// auto-rotate, wheel zoom, depth shading and backface culling so the silhouette
// reads as a solid globe.
function ImgSphere(props) {
  const images = props.images || [];
  const size = Number(props.size) || 560;
  const radius = Number(props.radius) || size * 0.44;
  const rows = Number(props.rows) || 12;
  // 360/cols at the equator should match the 180/rows band height, or the cells
  // come out letterboxed and the photos read as strips rather than tiles.
  const cols = Number(props.cols) || 24;
  const minRing = Number(props.minRing) || 7;
  const autoRotate = props.autoRotate !== false;
  const autoSpeed = props.autoRotateSpeed != null ? Number(props.autoRotateSpeed) : 0.16;
  const sensitivity = props.dragSensitivity != null ? Number(props.dragSensitivity) : 0.32;
  const onSelect = props.onSelect;

  const hostRef = useRef(null);
  const innerRef = useRef(null);
  const tileRefs = useRef([]);
  const rot = useRef({ x: -12, y: 20 });
  const vel = useRef({ x: 0, y: 0 });
  const drag = useRef(null);
  const zoom = useRef(1);
  const moved = useRef(0);
  const tick = useRef(0);

  // Facet layout.
  //
  // The globe is cut into exact spherical cells — a lat/long grid, `rows` bands
  // from pole to pole, each band split into `ring` cells of equal longitude —
  // and every cell is drawn as one flat photo laid tangent to the sphere at the
  // cell's centre. What matters for a seamless globe is that a facet covers
  // exactly its cell *as seen from the centre*: then the cells tile the sphere,
  // so the facets tile the silhouette with no gap and no overlap.
  //
  // Each facet's outline is therefore the cell boundary projected radially onto
  // the facet's own tangent plane. The two longitude edges come out straight
  // (they are where neighbouring tangent planes meet). The two latitude edges
  // come out *curved*, and that is the whole fix: drawing them as straight
  // chords — as this did before — left every corner short of the seam, and those
  // slivers were the red wedges ringing the globe and the torn pinwheel at each
  // pole. Both poles close on a single shared apex because the top band's upper
  // edge sits exactly at +90.
  const pts = useMemo(() => {
    const R = radius;
    const dLatDeg = 180 / rows;
    const frame = 1;                  // px of white border around each photo
    // Facets are separate elements, so where two of them abut, their antialiased
    // edges each land on the same pixel at partial coverage and the background
    // shows through as a hairline — worst where a seam is near edge-on and its
    // overlap foreshortens to nothing. So grow every facet past its cell.
    // Independent of `frame`: with no border the overlap lands on the neighbour's
    // photo instead of on shared white, which costs a couple of pixels of crop at
    // the seam and buys a shell with no background showing through.
    const bleed = 3;
    const out = [];

    for (let r = 0; r < rows; r++) {
      const latDeg = -90 + (r + 0.5) * dLatDeg;
      const lat = latDeg * D2R;
      const sinL = Math.sin(lat), cosL = Math.cos(lat);
      const ring = Math.max(minRing, Math.round(cols * Math.cos(lat)));
      const halfLon = Math.PI / ring;
      const phiTop = (latDeg + dLatDeg / 2) * D2R;
      const phiBot = (latDeg - dLatDeg / 2) * D2R;

      // Direction (phi, theta) projected onto this facet's tangent plane,
      // in the facet's own (east, north) axes with the facet centred at theta 0.
      const proj = (phi, theta) => {
        const cp = Math.cos(phi), sp = Math.sin(phi);
        const t = R / (sp * sinL + cp * Math.cos(theta) * cosL);
        const pz = t * cp * Math.cos(theta);
        return [t * cp * Math.sin(theta), t * sp * cosL - pz * sinL];
      };
      // Sample the curved edge into chords, ~3 degrees apart. abs() matters:
      // the bottom edge runs right-to-left to close the outline, and without it
      // that edge silently fell back to the 3-chord minimum.
      const arc = (phi, from, to) => {
        const n = Math.max(3, Math.min(32, Math.ceil(Math.abs(to - from) / (3 * D2R))));
        const a = [];
        for (let i = 0; i <= n; i++) a.push(proj(phi, from + ((to - from) * i) / n));
        return a;
      };
      // inset (or, negative, outset) the cell by dPhi/dTheta radians
      const HALF_PI = Math.PI / 2;
      const cell = (dPhi, dTheta) =>
        arc(Math.min(HALF_PI, phiTop - dPhi), -halfLon + dTheta, halfLon - dTheta)
          .concat(arc(Math.max(-HALF_PI, phiBot + dPhi), halfLon - dTheta, -halfLon + dTheta));

      const shape = cell(-bleed / R, -bleed / Math.max(1e-6, R * cosL));
      let uMax = 0, vMin = Infinity, vMax = -Infinity;
      for (let i = 0; i < shape.length; i++) {
        uMax = Math.max(uMax, Math.abs(shape[i][0]));
        vMin = Math.min(vMin, shape[i][1]);
        vMax = Math.max(vMax, shape[i][1]);
      }
      const w = Math.max(2 * uMax, 1), h = Math.max(vMax - vMin, 1);
      const vMid = (vMin + vMax) / 2;
      const hMid = R * cosL - vMid * sinL;   // distance from the polar axis
      const yMid = R * sinL + vMid * cosL;   // height above the equator

      // to the mask's 0..100 box
      const box = (pl) => pl.map((p) =>
        (50 + (100 * p[0]) / w).toFixed(2) + ',' + ((100 * (vMax - p[1])) / h).toFixed(2)).join(' ');
      // The photo's own outline: the same cell, inset by `frame` — and then back
      // out by `bleed`, because the facet it sits in was grown by that much. The
      // two cancel at frame 0, so the photo covers the facet exactly rather than
      // leaving the bleed showing as a white ring.
      const dPhi = Math.min(frame / R, 0.35 * (phiTop - phiBot)) - bleed / R;
      const dTheta = Math.min(frame / Math.max(1e-6, R * cosL), 0.35 * halfLon)
        - bleed / Math.max(1e-6, R * cosL);
      const clip = polyMask(box(shape));
      const clipIn = polyMask(box(cell(dPhi, dTheta)));
      // Rows are NOT staggered: where neighbouring bands carry the same ring
      // count the cell edges line up, and the grid reads as one lattice wrapping
      // the sphere rather than as brickwork.
      const spin = 0;

      for (let c = 0; c < ring; c++) {
        const lonDeg = spin + (c * 360) / ring;
        const lonR = lonDeg * D2R;
        out.push({
          cx: Math.sin(lonR) * hMid, cy: -yMid, cz: Math.cos(lonR) * hMid,
          lon: lonDeg, lat: latDeg,
          w, h, clip, clipIn,
        });
      }
    }
    return out;
  }, [radius, rows, cols, minRing]);

  useEffect(() => { tileRefs.current.length = pts.length; }, [pts]);

  useEffect(() => {
    let raf;
    const frame = () => {
      const r = rot.current, v = vel.current;
      if (!drag.current) {
        r.x += v.x; r.y += v.y;
        v.x *= 0.94; v.y *= 0.94;
        if (Math.abs(v.x) < 0.004) v.x = 0;
        if (Math.abs(v.y) < 0.004) v.y = 0;
        // Keeps turning under the cursor — only an actual drag takes it over.
        if (autoRotate) r.y += autoSpeed;
      }
      r.x = Math.max(-70, Math.min(70, r.x));
      if (innerRef.current) {
        innerRef.current.style.transform =
          'translateZ(0) scale(' + zoom.current + ') rotateX(' + r.x + 'deg) rotateY(' + r.y + 'deg)';
      }
      tick.current = (tick.current + 1) % 2;
      const rx = r.x * D2R, ry = r.y * D2R;
      if (tick.current === 0) { raf = requestAnimationFrame(frame); return; }
      const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
      for (let i = 0; i < pts.length; i++) {
        const el = tileRefs.current[i];
        if (!el) continue;
        const p = pts[i];
        // CSS-space point (y is down), rotated by the container's rotateX(rx) rotateY(ry)
        const z1 = -p.cx * sy + p.cz * cy;
        const z2 = p.cy * sx + z1 * cx;
        const d = (z2 + radius) / (2 * radius); // 0 back .. 1 front
        el.style.opacity = d < 0.5 ? String(Math.max(0, (d - 0.34) / 0.16)) : '1';
        el.style.zIndex = String(Math.round(1000 + z2));
        el.style.filter = 'brightness(' + (0.82 + d * 0.3).toFixed(3) + ') saturate(' + (0.92 + d * 0.16).toFixed(2) + ')';
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pts, radius, autoRotate, autoSpeed]);

  const down = useCallback((e) => {
    const t = e.touches ? e.touches[0] : e;
    // On touch the gesture's axis isn't known yet — see the move handler.
    drag.current = { x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, axis: e.touches ? null : 'free' };
    vel.current = { x: 0, y: 0 };
    moved.current = 0;
  }, []);

  useEffect(() => {
    const move = (e) => {
      const d = drag.current;
      if (!d) return;
      const t = e.touches ? e.touches[0] : e;
      // The globe fills most of a phone screen, so it must not swallow the
      // page scroll. Wait for a touch gesture to declare an axis: sideways is
      // a spin and we take it, up/down is a scroll and we hand it back.
      if (d.axis === null) {
        const tx = t.clientX - d.sx, ty = t.clientY - d.sy;
        if (Math.abs(tx) + Math.abs(ty) < 8) return;   // too early to tell
        if (Math.abs(ty) > Math.abs(tx)) {
          drag.current = null;
          moved.current = 999;  // and don't let the release read as a tap
          return;
        }
        d.axis = 'x';
        d.x = t.clientX; d.y = t.clientY;
        return;
      }
      const dx = t.clientX - d.x, dy = t.clientY - d.y;
      moved.current += Math.abs(dx) + Math.abs(dy);
      const vy = Math.max(-6, Math.min(6, dx * sensitivity));
      const vx = Math.max(-6, Math.min(6, -dy * sensitivity));
      rot.current.y += vy; rot.current.x += vx;
      vel.current = { x: vx * 0.7, y: vy * 0.7 };
      d.x = t.clientX; d.y = t.clientY;
      if (e.touches) e.preventDefault();
    };
    const up = () => { drag.current = null; };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', up);
    document.addEventListener('touchcancel', up);
    return () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', up);
      document.removeEventListener('touchcancel', up);
    };
  }, [sensitivity]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const wheel = (e) => {
      e.preventDefault();
      // Clamp: never below base size, never wider than the stage it sits in.
      // Walk up past zero-width wrappers — the host is mounted inside an inline
      // <span>, whose clientWidth is 0 and would pin maxZoom to 1.
      let stage = el.parentElement;
      while (stage && !stage.clientWidth) stage = stage.parentElement;
      const stageW = stage ? stage.clientWidth : window.innerWidth;
      const maxZoom = Math.max(1, Math.min(1.35, (stageW + 40) / size, (window.innerHeight * 0.92) / size));
      zoom.current = Math.max(1, Math.min(maxZoom, zoom.current - e.deltaY * 0.0011));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [size]);

  const half = size / 2;

  return React.createElement('div', {
    ref: hostRef,
    onMouseDown: down,
    onTouchStart: down,
    onMouseLeave: () => { drag.current = null; },
    style: {
      position: 'relative', width: size + 'px', height: size + 'px',
      perspective: size * 2.4 + 'px', cursor: 'grab', userSelect: 'none',
      touchAction: 'pan-y', flex: 'none', maxWidth: '100%',
    },
  },
    React.createElement('div', {
      ref: innerRef,
      style: {
        position: 'absolute', inset: 0, transformStyle: 'preserve-3d',
        willChange: 'transform',
      },
    },
      pts.map((p, i) => {
        const img = images[i % images.length] || {};
        return React.createElement('div', {
          key: i,
          ref: (el) => { tileRefs.current[i] = el; },
          onClick: () => { if (moved.current < 6 && onSelect) onSelect(img, i); },
          style: {
            position: 'absolute',
            left: half - p.w / 2 + 'px', top: half - p.h / 2 + 'px',
            width: p.w.toFixed(2) + 'px', height: p.h.toFixed(2) + 'px',
            backfaceVisibility: 'hidden',
            transform: 'translate3d(' + p.cx.toFixed(2) + 'px,' + p.cy.toFixed(2) + 'px,' + p.cz.toFixed(2) + 'px) rotateY(' + p.lon.toFixed(2) + 'deg) rotateX(' + p.lat.toFixed(2) + 'deg)',
            transition: 'filter .12s linear',
            WebkitMaskImage: p.clip, maskImage: p.clip,
            WebkitMaskSize: '100% 100%', maskSize: '100% 100%',
            WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
            background: '#fff',
            cursor: 'pointer',
          },
        },
          React.createElement('img', {
            src: img.src, alt: img.alt || '', draggable: false,
            loading: i < 8 ? 'eager' : 'lazy',
            style: {
              width: '100%', height: '100%', objectFit: 'cover', display: 'block',
              WebkitMaskImage: p.clipIn, maskImage: p.clipIn,
              WebkitMaskSize: '100% 100%', maskSize: '100% 100%',
              WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
              pointerEvents: 'none',
            },
          })
        );
      })
    )
  );
}

if (typeof module !== 'undefined') module.exports = { ImgSphere };
window.ImgSphere = ImgSphere;
