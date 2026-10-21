# The C++ TurboModule, added to the app's native build by autolinking (react-native.config.js):
# cpp/ over native/hbcpack.c and the bundled zstd decompressor and brotli decoder sources.
cmake_minimum_required(VERSION 3.13)
project(kodespire_hbcpack C CXX)

set(ROOT ${CMAKE_CURRENT_LIST_DIR}/..)
set(ZSTD ${ROOT}/deps/zstd/lib)
set(BROTLI ${ROOT}/deps/brotli/c)
file(GLOB ZSTD_SOURCES ${ZSTD}/common/*.c ${ZSTD}/decompress/*.c)
file(GLOB BROTLI_SOURCES ${BROTLI}/common/*.c ${BROTLI}/dec/*.c)

add_library(kodespire_hbcpack STATIC
  ${ROOT}/cpp/KodespireHbcPackModule.cpp
  ${ROOT}/native/hbcpack.c
  ${ZSTD_SOURCES}
  ${BROTLI_SOURCES})

target_include_directories(kodespire_hbcpack
  PUBLIC ${ROOT}/cpp
  PRIVATE ${ROOT}/native ${ZSTD} ${ZSTD}/common ${BROTLI}/include)
target_compile_definitions(kodespire_hbcpack PRIVATE
  ZSTD_LEGACY_SUPPORT=0 ZSTD_DISABLE_ASM ZSTD_NO_TRACE XXH_NAMESPACE=ZSTD_ ZSTD_MULTITHREAD=0)
# zstd/brotli symbols are renamed (native/hbcpack_symbols.h) so this library can coexist with
# @kodespire/zstd-js and @kodespire/brotli-js. -O3 in debug builds too.
target_compile_options(kodespire_hbcpack PRIVATE -O3 -fvisibility=hidden -include ${ROOT}/native/hbcpack_symbols.h)
set_target_properties(kodespire_hbcpack PROPERTIES CXX_STANDARD 20 CXX_STANDARD_REQUIRED ON)

target_link_libraries(kodespire_hbcpack ReactAndroid::jsi ReactAndroid::reactnative)
