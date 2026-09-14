// asr-web: entry point of the combined WebAssembly module.
// Replaces wasm/vad-asr/sherpa-onnx-wasm-main-vad-asr.cc in the sherpa-onnx tree.
#include <stdint.h>

#include <algorithm>

#include "sherpa-onnx/c-api/c-api.h"

extern "C" {

// The JS wrappers from sherpa-onnx build C structs field by field and glue them
// together with CopyHeap. The static_asserts guard the layouts the wrappers assume.
static_assert(sizeof(SherpaOnnxOfflineSpeakerSegmentationPyannoteModelConfig) == 2 * 4, "");
static_assert(sizeof(SherpaOnnxOfflineSpeakerSegmentationModelConfig) ==
                  sizeof(SherpaOnnxOfflineSpeakerSegmentationPyannoteModelConfig) + 3 * 4,
              "");
static_assert(sizeof(SherpaOnnxFastClusteringConfig) == 3 * 4, "");
static_assert(sizeof(SherpaOnnxSpeakerEmbeddingExtractorConfig) == 4 * 4, "");
static_assert(sizeof(SherpaOnnxOfflineSpeakerDiarizationConfig) ==
                  sizeof(SherpaOnnxOfflineSpeakerSegmentationModelConfig) +
                      sizeof(SherpaOnnxSpeakerEmbeddingExtractorConfig) +
                      sizeof(SherpaOnnxFastClusteringConfig) + 2 * 4,
              "");

void CopyHeap(const char *src, int32_t num_bytes, char *dst) {
  std::copy(src, src + num_bytes, dst);
}
}
