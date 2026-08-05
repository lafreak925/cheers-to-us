#!/usr/bin/env python3
"""Rebuild standalone-offline.html from index.html + ImgSphere.jsx + support.js.

standalone-offline.html is the double-clickable copy of the page: the dc runtime,
React, ReactDOM, Babel and the webfonts are all inlined into it, so it opens from
file:// with no server and no network. (index.html can't — a file:// page is not
allowed to fetch ./ImgSphere.jsx.) The photos are NOT inlined; keep the photos/
folder next to it — and the video/ folder too, which the phone globe plays from.

The bundle carries its own unpacker plus two data blocks:
  __bundler/manifest  {uuid: {mime, compressed, data(base64)}}
  __bundler/template  the page HTML, JSON-encoded, with local URLs swapped
                      for manifest uuids
This script rewrites both from the working files and leaves everything else in
the bundle untouched.

Usage: python3 build-standalone.py
"""
import base64
import gzip
import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BUNDLE = ROOT / "standalone-offline.html"
MANIFEST_TAG = '<script type="__bundler/manifest">'
TEMPLATE_TAG = '<script type="__bundler/template">'

# Attributes the runtime needs case-preserved. DOMParser lowercases attribute
# names, so the bundle spells them out instead.
CAMEL = ["onClick", "onKeyDown", "onSelect", "autoRotate", "viewBox", "autoPlay", "playsInline"]


def block(src, tag):
    """Span of the payload inside a <script type=...> block."""
    start = src.index(tag) + len(tag)
    return start, src.index("</script>", start)


def gz(data: bytes) -> str:
    buf = io.BytesIO()
    # mtime=0 so rebuilding unchanged input produces an identical bundle
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as f:
        f.write(data)
    return base64.b64encode(buf.getvalue()).decode()


def kebab(name):
    return re.sub(r"(?<!^)(?=[A-Z])", "-", name).lower()


def main():
    src = BUNDLE.read_text(encoding="utf-8")
    m_start, m_end = block(src, MANIFEST_TAG)
    t_start, t_end = block(src, TEMPLATE_TAG)
    manifest = json.loads(src[m_start:m_end])
    old_template = json.loads(src[t_start:t_end])

    # Locate the two entries we own by their current contents.
    def uuid_of(needle):
        for uuid, entry in manifest.items():
            raw = base64.b64decode(entry["data"])
            if entry["compressed"]:
                raw = gzip.decompress(raw)
            if needle in raw[:200]:
                return uuid
        sys.exit("could not find %r in the bundle manifest" % needle)

    runtime_uuid = uuid_of(b"GENERATED from dc-runtime")
    jsx_uuid = uuid_of(b"const { useRef, useEffect")

    manifest[runtime_uuid]["data"] = gz((ROOT / "support.js").read_bytes())
    manifest[jsx_uuid]["data"] = gz((ROOT / "ImgSphere.jsx").read_bytes())

    # The bundle inlines the Google Fonts stylesheet; lift it off the old
    # template so we don't have to re-download the fonts.
    font_css = re.search(r"<style>/\* vietnamese \*/.*?</style>", old_template, re.S)
    if not font_css:
        sys.exit("could not find the inlined @font-face block in the old template")

    page = (ROOT / "index.html").read_text(encoding="utf-8")
    # The thumbnail lives in the bundle's own loading screen, not in the page.
    page = re.sub(r'<template id="__bundler_thumbnail">.*?</template>\s*', "", page, flags=re.S)
    page = page.replace('<script src="./support.js"></script>',
                        '<script src="%s"></script>' % runtime_uuid)
    page = page.replace('from="./ImgSphere.jsx"',
                        'from="%s#/ImgSphere.jsx"' % jsx_uuid)
    page = re.sub(r'<link href="https://fonts\.googleapis\.com/css2\?[^"]*" rel="stylesheet">',
                  font_css.group(), page, count=1)
    for name in CAMEL:
        page = page.replace(name + "=", "sc-camel-" + kebab(name) + "=")

    for leftover in ("./support.js", "./ImgSphere.jsx", "fonts.googleapis.com/css2"):
        if leftover in page:
            sys.exit("template still references %s — bundle would need the network" % leftover)

    # The template is JSON *inside* a <script>, so a literal "</script>" in the
    # markup would close the tag early. Escape every "</" the way the bundler
    # does — still valid JSON, decodes back to the same characters.
    template = json.dumps(page).replace("</", "<\\u002F")

    out = (src[:m_start] + json.dumps(manifest) + src[m_end:t_start]
           + template + src[t_end:])
    BUNDLE.write_text(out, encoding="utf-8")
    print("standalone-offline.html rebuilt (%.1f MB)" % (len(out) / 1e6))


if __name__ == "__main__":
    main()
