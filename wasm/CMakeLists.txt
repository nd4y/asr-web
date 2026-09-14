# asr-web: one WebAssembly module for VAD + non-streaming ASR + speaker diarization.
#
# This file replaces wasm/vad-asr/CMakeLists.txt in the sherpa-onnx source tree at build
# time (see build-in-container.sh). Differences from upstream:
#   - exports the union of the vad-asr and speaker-diarization C API functions;
#   - no --preload-file: models are written into MEMFS at runtime by the app;
#   - ES6 module (MODULARIZE + EXPORT_ES6) so Vite can import it from a worker;
#   - FS exported so the app can create files.

if(NOT $ENV{SHERPA_ONNX_IS_USING_BUILD_WASM_SH})
  message(FATAL_ERROR "Set SHERPA_ONNX_IS_USING_BUILD_WASM_SH=ON (see build-in-container.sh)")
endif()

set(exported_functions
  # VAD
  SherpaOnnxCreateCircularBuffer
  SherpaOnnxDestroyCircularBuffer
  SherpaOnnxCircularBufferPush
  SherpaOnnxCircularBufferGet
  SherpaOnnxCircularBufferFree
  SherpaOnnxCircularBufferPop
  SherpaOnnxCircularBufferSize
  SherpaOnnxCircularBufferHead
  SherpaOnnxCircularBufferReset
  SherpaOnnxCreateVoiceActivityDetector
  SherpaOnnxDestroyVoiceActivityDetector
  SherpaOnnxVoiceActivityDetectorAcceptWaveform
  SherpaOnnxVoiceActivityDetectorEmpty
  SherpaOnnxVoiceActivityDetectorDetected
  SherpaOnnxVoiceActivityDetectorPop
  SherpaOnnxVoiceActivityDetectorClear
  SherpaOnnxVoiceActivityDetectorFront
  SherpaOnnxDestroySpeechSegment
  SherpaOnnxVoiceActivityDetectorReset
  SherpaOnnxVoiceActivityDetectorFlush
  # non-streaming ASR
  SherpaOnnxAcceptWaveformOffline
  SherpaOnnxCreateOfflineRecognizer
  SherpaOnnxCreateOfflineStream
  SherpaOnnxDecodeMultipleOfflineStreams
  SherpaOnnxDecodeOfflineStream
  SherpaOnnxDestroyOfflineRecognizer
  SherpaOnnxDestroyOfflineRecognizerResult
  SherpaOnnxDestroyOfflineStream
  SherpaOnnxDestroyOfflineStreamResultJson
  SherpaOnnxGetOfflineStreamResult
  SherpaOnnxGetOfflineStreamResultAsJson
  # speaker diarization
  SherpaOnnxCreateOfflineSpeakerDiarization
  SherpaOnnxDestroyOfflineSpeakerDiarization
  SherpaOnnxOfflineSpeakerDiarizationDestroyResult
  SherpaOnnxOfflineSpeakerDiarizationDestroySegment
  SherpaOnnxOfflineSpeakerDiarizationGetSampleRate
  SherpaOnnxOfflineSpeakerDiarizationProcess
  SherpaOnnxOfflineSpeakerDiarizationProcessWithCallback
  SherpaOnnxOfflineSpeakerDiarizationResultGetNumSegments
  SherpaOnnxOfflineSpeakerDiarizationResultSortByStartTime
  SherpaOnnxOfflineSpeakerDiarizationSetConfig
  #
  SherpaOnnxFileExists
)
set(mangled_exported_functions)
foreach(x IN LISTS exported_functions)
  list(APPEND mangled_exported_functions "_${x}")
endforeach()
list(JOIN mangled_exported_functions "," all_exported_functions)

include_directories(${CMAKE_SOURCE_DIR})
set(MY_FLAGS " -s FORCE_FILESYSTEM=1 -s INITIAL_MEMORY=512MB -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=4GB")
string(APPEND MY_FLAGS " -sSTACK_SIZE=10485760 ") # 10MB
string(APPEND MY_FLAGS " -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createSherpaOnnx -sENVIRONMENT=web,worker,node ")
string(APPEND MY_FLAGS " -sEXPORTED_FUNCTIONS=[_CopyHeap,_malloc,_free,${all_exported_functions}] ")
string(APPEND MY_FLAGS " -sEXPORTED_RUNTIME_METHODS=['ccall','stringToUTF8','setValue','getValue','lengthBytesUTF8','UTF8ToString','HEAPU8','HEAP16','HEAP32','HEAPU32','HEAPF32','HEAPF64','FS'] ")

message(STATUS "MY_FLAGS: ${MY_FLAGS}")

set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} ${MY_FLAGS}")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${MY_FLAGS}")
set(CMAKE_EXECUTABLE_LINKER_FLAGS "${CMAKE_EXECUTABLE_LINKER_FLAGS} ${MY_FLAGS}")

if (NOT CMAKE_EXECUTABLE_SUFFIX STREQUAL ".js")
  message(FATAL_ERROR "The default suffix for building executables should be .js!")
endif()

add_executable(sherpa-onnx-asr-web sherpa-onnx-wasm-main-vad-asr.cc)
target_link_libraries(sherpa-onnx-asr-web sherpa-onnx-c-api)
install(TARGETS sherpa-onnx-asr-web DESTINATION bin/wasm/asr-web)

install(
  FILES
    "$<TARGET_FILE_DIR:sherpa-onnx-asr-web>/sherpa-onnx-asr-web.js"
    "$<TARGET_FILE_DIR:sherpa-onnx-asr-web>/sherpa-onnx-asr-web.wasm"
  DESTINATION
    bin/wasm/asr-web
)
