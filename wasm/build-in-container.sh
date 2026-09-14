#!/usr/bin/env bash
# Builds the combined sherpa-onnx WebAssembly module (VAD + ASR + speaker diarization).
# Runs inside emscripten/emsdk (see build.sh); expects the repo mounted at /src.
#
# Output: /src/wasm/dist/sherpa-onnx-asr-web.{js,wasm} plus the sherpa-onnx JS wrappers
# for VAD, ASR and diarization copied next to them.
set -euo pipefail

SHERPA_ONNX_TAG="${SHERPA_ONNX_TAG:-v1.13.8}"
SRC=/src/wasm
WORK="${WASM_WORK_DIR:-/src/wasm/.work}"
JOBS="${JOBS:-$(nproc)}"

mkdir -p "$WORK"
cd "$WORK"

if [ ! -d sherpa-onnx ]; then
  git clone --depth 1 --branch "$SHERPA_ONNX_TAG" https://github.com/k2-fsa/sherpa-onnx.git
fi
cd sherpa-onnx
git fetch --depth 1 origin "refs/tags/$SHERPA_ONNX_TAG:refs/tags/$SHERPA_ONNX_TAG" 2>/dev/null || true
git checkout -q "$SHERPA_ONNX_TAG"

# Replace the upstream vad-asr target with ours (same directory, so the existing
# SHERPA_ONNX_ENABLE_WASM_VAD_ASR switch wires it in without touching other CMake files).
cp -f "$SRC/CMakeLists.txt" wasm/vad-asr/CMakeLists.txt
cp -f "$SRC/main.cc" wasm/vad-asr/sherpa-onnx-wasm-main-vad-asr.cc

export SHERPA_ONNX_IS_USING_BUILD_WASM_SH=ON
EMSCRIPTEN="${EMSCRIPTEN:-$(dirname "$(realpath "$(which emcc)")")}"

mkdir -p build-asr-web
cd build-asr-web
cmake \
  -DCMAKE_INSTALL_PREFIX=./install \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$EMSCRIPTEN/cmake/Modules/Platform/Emscripten.cmake" \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
  -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_TTS=OFF \
  -DSHERPA_ONNX_ENABLE_C_API=ON \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DSHERPA_ONNX_ENABLE_GPU=OFF \
  -DSHERPA_ONNX_ENABLE_WASM=ON \
  -DSHERPA_ONNX_ENABLE_WASM_VAD_ASR=ON \
  -DSHERPA_ONNX_ENABLE_BINARY=OFF \
  -DSHERPA_ONNX_LINK_LIBSTDCPP_STATICALLY=OFF \
  ..
make -j"$JOBS"
make install

OUT="$SRC/dist"
mkdir -p "$OUT"
cp -fv install/bin/wasm/asr-web/sherpa-onnx-asr-web.js "$OUT/"
cp -fv install/bin/wasm/asr-web/sherpa-onnx-asr-web.wasm "$OUT/"
cp -fv ../wasm/vad/sherpa-onnx-vad.js "$OUT/"
cp -fv ../wasm/asr/sherpa-onnx-asr.js "$OUT/"
cp -fv ../wasm/speaker-diarization/sherpa-onnx-speaker-diarization.js "$OUT/"
echo "$SHERPA_ONNX_TAG" > "$OUT/SHERPA_ONNX_VERSION"
ls -lh "$OUT"
