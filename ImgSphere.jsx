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
  // Density follows the globe, because every facet is a separately composited
  // layer carrying two SVG masks and a style write on each depth pass. A phone
  // was rendering the desktop's 192 of them into a 360px circle — 25px a piece,
  // detail nobody can see, for roughly double the per-frame cost. 8 rows there
  // is 86 facets. `rows` must stay even (the polar bands have to meet on one
  // apex) and `cols` twice `rows`, or 360/cols at the equator stops matching the
  // 180/rows band height and the cells come out letterboxed.
  // A phone that reports four cores or less is the one this used to be unusable
  // on, so it drops another tier: 6 rows is 50 facets against a desktop's 192.
  // Both figures are advisory and often absent — assume the roomy case.
  const lean = typeof navigator !== 'undefined' &&
    ((navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4);
  const rows = Number(props.rows) || (size < 520 ? (lean ? 6 : 8) : 12);
  const cols = Number(props.cols) || rows * 2;
  const minRing = Number(props.minRing) || (rows < 12 ? 5 : 7);
  // Per-facet CSS filters are a compositing pass each, and on a phone that is
  // 50-86 of them every frame for a shading gradient nobody is studying. Depth
  // there is carried by the back-face fade alone.
  const shadeFilter = size >= 520;
  const autoRotate = props.autoRotate !== false;
  const autoSpeed = props.autoRotateSpeed != null ? Number(props.autoRotateSpeed) : 0.16;
  // Degrees of spin per px dragged, tuned against a desktop-sized globe. A phone's
  // globe is less than half as wide, so the same swipe crosses far fewer pixels and
  // the same px-based rate feels sluggish — a drag should turn the globe by what it
  // crossed *of the globe*, so scale the rate back up as the globe shrinks.
  const sensitivity = props.dragSensitivity != null
    ? Number(props.dragSensitivity)
    : Math.min(0.8, Math.max(0.32, (0.32 * 760) / size));
  const onSelect = props.onSelect;
  // Phones hand the idle spin to the compositor: one CSS animation on the
  // container instead of a script loop rewriting every facet each frame. Nothing
  // is computed per frame until a finger is actually on the globe, and the
  // browser keeps animating it off the main thread, so page scroll stays smooth
  // no matter what else is running. Declared after autoSpeed, which it needs.
  const cssSpin = size < 520;
  const spinPeriod = 360 / (autoSpeed * 60);   // seconds for one full turn

  const hostRef = useRef(null);
  const innerRef = useRef(null);
  const tileRefs = useRef([]);
  const rot = useRef({ x: -12, y: 20 });
  const vel = useRef({ x: 0, y: 0 });
  const drag = useRef(null);
  const zoom = useRef(1);
  const moved = useRef(0);
  const tick = useRef(0);
  const shade = useRef([]);
  const lastZ = useRef([]);
  const spinFrom = useRef(0);   // angle the CSS animation was handed
  const spinAt = useRef(0);     // when it was handed over
  const spinning = useRef(false);
  // Latched once the compositor has refused the animation, so the globe stops
  // being offered back to it — see the tail of attachSpin.
  const spinDead = useRef(false);
  const loopCtl = useRef(null);
  // The depth pass is the expensive half of the loop, and it only feeds shading
  // and stacking — nothing positional — so a phone can run it every third frame.
  const shadeEvery = size < 520 ? 3 : 2;

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
    // px of white border around each photo. Must stay above `bleed` or the
    // photo's outset swallows it: below that the two cancel and no white shows.
    // Above it the overlap lands on shared white and the seam settles at 2*frame,
    // so this is a 4px hairline between neighbours.
    const frame = 2;
    // Facets are separate elements, so where two of them abut, their antialiased
    // edges each land on the same pixel at partial coverage and the background
    // shows through as a hairline — worst where a seam is near edge-on and its
    // overlap foreshortens to nothing. So grow every facet past its cell.
    // Independent of `frame`: with no border the overlap lands on the neighbour's
    // photo instead of on shared white, which costs a couple of pixels of crop at
    // the seam and buys a shell with no background showing through.
    const bleed = 1.2;
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
      // The exact cell: the two latitude edges sampled as curves, closed by the
      // straight longitude edges where neighbouring tangent planes meet.
      const HALF_PI = Math.PI / 2;
      const cell = () =>
        arc(Math.min(HALF_PI, phiTop), -halfLon, halfLon)
          .concat(arc(Math.max(-HALF_PI, phiBot), halfLon, -halfLon));

      // Grow (or, negative, shrink) the finished outline along its own normal.
      // Doing it here rather than by shifting the cell's lat/long bounds keeps
      // the offset a true, even px distance all the way round — on a curved
      // latitude edge an angular inset is not, and the border came out uneven
      // between the middle of an edge and its corners.
      const offset = (poly, d) => {
        const n = poly.length;
        return poly.map((p, i) => {
          let nx = 0, ny = 0;
          const edges = [[poly[(i - 1 + n) % n], p], [p, poly[(i + 1) % n]]];
          for (let k = 0; k < 2; k++) {
            const ex = edges[k][1][0] - edges[k][0][0], ey = edges[k][1][1] - edges[k][0][1];
            const len = Math.hypot(ex, ey);
            if (len > 1e-9) { nx += -ey / len; ny += ex / len; }
          }
          const len = Math.hypot(nx, ny);
          // a collapsed corner — both poles have one — has no normal to follow
          return len > 1e-9 ? [p[0] + (d * nx) / len, p[1] + (d * ny) / len] : p;
        });
      };

      const nominal = cell();
      const shape = offset(nominal, bleed);
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
      // The photo's own outline: the facet, inset by `frame`. At frame 0 the two
      // coincide and the photo covers the facet exactly rather than leaving the
      // bleed showing as a white ring.
      const clip = polyMask(box(shape));
      const clipIn = polyMask(box(offset(nominal, bleed - frame)));
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

  useEffect(() => {
    tileRefs.current.length = pts.length;
    // stale shading steps would suppress the first write against a new grid
    shade.current = [];
    lastZ.current = [];
  }, [pts]);

  // The keyframes for that compositor spin. Injected rather than written into
  // the page's stylesheet so the component stays self-contained — it is loaded
  // by <x-import> and has no stylesheet of its own.
  useEffect(() => {
    if (!cssSpin || document.getElementById('imgsphere-spin')) return;
    const s = document.createElement('style');
    s.id = 'imgsphere-spin';
    s.textContent =
      '@keyframes imgsphere-spin{' +
      'from{transform:translateZ(0) rotateX(var(--sx,-12deg)) rotateY(0deg)}' +
      'to{transform:translateZ(0) rotateX(var(--sx,-12deg)) rotateY(360deg)}}';
    document.head.appendChild(s);
  }, [cssSpin]);

  // Where the CSS spin has got to. The animation is linear and started at a
  // known angle and time, so this is arithmetic rather than reading a matrix
  // back out of the compositor.
  const spinAngle = useCallback(() => {
    if (!spinning.current) return rot.current.y;
    const secs = (performance.now() - spinAt.current) / 1000;
    return spinFrom.current + (secs / spinPeriod) * 360;
  }, [spinPeriod]);

  const attachSpin = useCallback(() => {
    const el = innerRef.current;
    if (!el || !autoRotate) return;
    // Already established that this browser will not keep the animation: the
    // loop is the only thing that turns the globe from here on.
    if (spinDead.current) {
      if (loopCtl.current) loopCtl.current.start();
      return;
    }
    const y = ((rot.current.y % 360) + 360) % 360;
    el.style.setProperty('--sx', rot.current.x + 'deg');
    // Hand the transform back to the keyframes. The loop leaves an inline
    // transform behind on every touch, and an inline value is exactly what the
    // globe sits frozen on if the animation does not come back — the element
    // keeps the last angle the loop wrote and nothing ever moves it again. With
    // it cleared the keyframes are the only thing driving this element, so a
    // failure to restart is visible here rather than silent on a phone.
    el.style.transform = '';
    // Restart deliberately rather than by assignment. Going 'none' -> the same
    // string can land in one style pass, and a computed value that never
    // changed is not a new animation: the engine is entitled to carry on with
    // the old one, or to drop it. The reflow between the two writes forces the
    // restart. It costs one layout per hand-back — once per touch, not per
    // frame — which is why it can sit on the phone path at all.
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = 'imgsphere-spin ' + spinPeriod + 's linear infinite';
    // negative delay: the animation resumes at the angle the drag left it on
    el.style.animationDelay = -(y / 360) * spinPeriod + 's';
    spinFrom.current = y;
    spinAt.current = performance.now();
    spinning.current = true;
    // Last resort. If the animation still is not running a frame later, the
    // globe would be stopped for good, so drive it from the loop instead: the
    // per-frame cost is the thing cssSpin exists to avoid, but a globe that
    // turns costs less than one that does not.
    requestAnimationFrame(() => {
      if (!spinning.current || !innerRef.current) return;
      const live = typeof el.getAnimations === 'function' && el.getAnimations().length > 0;
      if (!live) {
        spinning.current = false;
        spinDead.current = true;
        if (loopCtl.current) loopCtl.current.start();
      }
    });
  }, [autoRotate, spinPeriod]);

  const detachSpin = useCallback(() => {
    const el = innerRef.current;
    if (!el) return;
    const y = spinAngle();
    rot.current.y = y;
    spinning.current = false;
    // Pin the angle the animation had reached before dropping it. Removing the
    // animation with nothing inline leaves the element on its base transform
    // until the loop's first frame writes one, which reads as a snap back to
    // where the globe started every time a finger lands on it.
    el.style.transform =
      'translateZ(0) scale(' + zoom.current + ') rotateX(' + rot.current.x + 'deg) rotateY(' + y + 'deg)';
    el.style.animation = 'none';
  }, [spinAngle]);

  useEffect(() => {
    let raf = 0, prev = 0;
    const frame = (now) => {
      // Everything below is integrated against real elapsed time rather than per
      // frame. A phone rendering at 30fps — or any device throttling under load —
      // otherwise spins the globe at exactly half speed and decays momentum at
      // half the rate. Clamped so a backgrounded tab doesn't resume with a lurch.
      const dt = prev ? Math.min(3, (now - prev) / 16.67) : 1;
      prev = now;
      const r = rot.current, v = vel.current;
      if (!drag.current) {
        r.x += v.x * dt; r.y += v.y * dt;
        const decay = Math.pow(0.94, dt);
        v.x *= decay; v.y *= decay;
        if (Math.abs(v.x) < 0.004) v.x = 0;
        if (Math.abs(v.y) < 0.004) v.y = 0;
        // Keeps turning under the cursor — only an actual drag takes it over.
        if (autoRotate) r.y += autoSpeed * dt;
      }
      r.x = Math.max(-70, Math.min(70, r.x));
      if (innerRef.current) {
        innerRef.current.style.transform =
          'translateZ(0) scale(' + zoom.current + ') rotateX(' + r.x + 'deg) rotateY(' + r.y + 'deg)';
      }
      // On a phone the loop exists only to carry a drag and its momentum. Once
      // the globe is still again the CSS animation takes it back and the loop
      // stops outright — no script runs per frame while it idles.
      if (cssSpin) {
        // Once the animation has been refused there is nothing to hand back to,
        // so the loop stays up and carries the idle spin itself. It still skips
        // the depth pass below, which is the expensive half — this costs one
        // container transform a frame, the same work the keyframes were doing.
        if (!spinDead.current && !drag.current && !v.x && !v.y) {
          attachSpin();
          raf = 0;
          return;
        }
        raf = requestAnimationFrame(frame);
        return;
      }
      tick.current = (tick.current + 1) % shadeEvery;
      const rx = r.x * D2R, ry = r.y * D2R;
      if (tick.current !== 0) { raf = requestAnimationFrame(frame); return; }
      const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
      const last = shade.current;
      for (let i = 0; i < pts.length; i++) {
        const el = tileRefs.current[i];
        if (!el) continue;
        const p = pts[i];
        // CSS-space point (y is down), rotated by the container's rotateX(rx) rotateY(ry)
        const z1 = -p.cx * sy + p.cz * cy;
        const z2 = p.cy * sx + z1 * cx;
        const d = (z2 + radius) / (2 * radius); // 0 back .. 1 front
        // Quantised, and written only when the step actually changes. Assigning
        // the same value still costs a style recalc, and over a slow rotation
        // most facets sit in the same step for many passes — on a phone this
        // drops the vast majority of the writes this loop used to make.
        const step = Math.round(d * 64);
        const z = Math.round(1000 + z2);
        if (last[i] !== step) {
          last[i] = step;
          const q = step / 64;
          el.style.opacity = q < 0.5 ? String(Math.max(0, (q - 0.34) / 0.16)) : '1';
          if (shadeFilter) {
            el.style.filter =
              'brightness(' + (0.82 + q * 0.3).toFixed(3) + ') saturate(' + (0.92 + q * 0.16).toFixed(2) + ')';
          }
        }
        if (lastZ.current[i] !== z) { lastZ.current[i] = z; el.style.zIndex = String(z); }
      }
      raf = requestAnimationFrame(frame);
    };
    const start = () => { if (!raf) { prev = 0; raf = requestAnimationFrame(frame); } };
    const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
    loopCtl.current = { start, stop };

    // No IntersectionObserver gate here. Pausing the loop off-screen sounds free
    // and is not: when the callback does not arrive the globe simply never
    // moves, which is exactly what happened on phones, and the failure is silent.
    // The compositor spin below makes the saving moot anyway — browsers already
    // throttle an off-screen CSS animation.
    if (cssSpin) attachSpin(); else start();
    const onVis = () => {
      if (document.hidden) stop();
      // spinDead means the loop is carrying the idle spin, so it has to come
      // back with the tab — there is no animation waiting to take over.
      else if (!cssSpin || spinDead.current || drag.current) start();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [pts, radius, autoRotate, autoSpeed, shadeEvery, shadeFilter, cssSpin, attachSpin]);

  const down = useCallback((e) => {
    // take the globe back off the compositor at whatever angle it had reached,
    // and wake the loop that carries the drag
    if (cssSpin) {
      detachSpin();
      if (loopCtl.current) loopCtl.current.start();
    }
    const t = e.touches ? e.touches[0] : e;
    // On touch the gesture's axis isn't known yet — see the move handler.
    drag.current = { x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, axis: e.touches ? null : 'free' };
    vel.current = { x: 0, y: 0 };
    moved.current = 0;
  }, [cssSpin, detachSpin]);

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
    const up = () => {
      drag.current = null;
      // A release with no throw behind it — a tap, or a drag that ended still —
      // hands straight back to the compositor rather than waiting on a frame to
      // notice. Under a throttled rAF that frame can be a long time coming, and
      // until it does the globe just sits there. With momentum, the loop carries
      // it and hands over when the velocity dies.
      const v = vel.current;
      if (cssSpin && Math.abs(v.x) < 0.01 && Math.abs(v.y) < 0.01) {
        if (loopCtl.current) loopCtl.current.stop();
        attachSpin();
      }
    };
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
  }, [sensitivity, cssSpin, attachSpin]);

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
      // fall through to the facets
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
            // No filter transition: the depth pass rewrites brightness every
            // pass, so each write would start its own interpolation and keep the
            // compositor busy between frames. The steps are ~0.005 apart, well
            // under what the eye can pick up, so nothing needs smoothing.
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
            // off the main thread: a synchronous decode of a texture lands as a
            // dropped frame, and the globe is mid-spin the whole time they arrive
            decoding: 'async',
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
    ),
    // Sphere lighting, faked in one static element. Phones get no per-facet
    // brightness any more, so without this the grid reads as a flat mosaic
    // rather than something round: a highlight up and left, and the rim falling
    // away into shadow. It sits over the facets, so it must not eat their taps.
    cssSpin ? React.createElement('div', {
      key: 'shade',
      'aria-hidden': 'true',
      style: {
        position: 'absolute', pointerEvents: 'none', borderRadius: '50%',
        left: half - radius + 'px', top: half - radius + 'px',
        width: radius * 2 + 'px', height: radius * 2 + 'px',
        background:
          'radial-gradient(circle at 34% 28%, rgba(255,255,255,.20), rgba(255,255,255,0) 46%),' +
          'radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 58%, rgba(0,0,0,.22) 84%, rgba(0,0,0,.42) 100%)',
      },
    }) : null
  );
}

if (typeof module !== 'undefined') module.exports = { ImgSphere };
window.ImgSphere = ImgSphere;
