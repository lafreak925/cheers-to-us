#!/usr/bin/env bash
# Serve the site on localhost. index.html loads ./ImgSphere.jsx over fetch, which
# a file:// page is not allowed to do — so it needs a server, any server.
#   ./serve.sh          -> http://localhost:8000
#   ./serve.sh 3000     -> http://localhost:3000
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8000}"
URL="http://localhost:$PORT/index.html"

echo "Cheers To Us  ->  $URL   (ctrl-c to stop)"
command -v open >/dev/null && (sleep 1; open "$URL") &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
