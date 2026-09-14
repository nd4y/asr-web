#!/usr/bin/env bash
# Builds wasm/dist/* with the pinned emscripten SDK in Docker. Run from anywhere:
#   ./wasm/build.sh
# Environment: SHERPA_ONNX_TAG (default in build-in-container.sh), JOBS, EMSDK_IMAGE.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:4.0.23}"
docker run --rm \
  -v "$REPO:/src" \
  -e SHERPA_ONNX_TAG \
  -e JOBS \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  "$IMAGE" bash /src/wasm/build-in-container.sh
