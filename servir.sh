#!/bin/sh
# Los módulos ES y el AudioWorklet no funcionan desde file://.
# Este script sirve la carpeta por HTTP en el puerto 8000.
set -e
cd "$(dirname "$0")"
echo "Abre http://localhost:8000 en Chrome, Edge o Safari."
exec python3 -m http.server 8000
