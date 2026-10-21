#!/bin/sh
# Builds the decoder as static libraries for iOS (device + simulator, packaged as an xcframework)
# and Android (arm64-v8a, armeabi-v7a, x86_64; static and shared), with zstd's decompressor and
# brotli's decoder compiled from source. No Xcode project, Gradle or CMake involved.
#
#   sh native/build-mobile.sh            # both platforms
#   sh native/build-mobile.sh ios        # one platform
#   sh native/build-mobile.sh android
#
# Sources: ZSTD_SRC and BROTLI_SRC default to the sibling repos' vendored copies.
set -e
cd "$(dirname "$0")"
ROOT=$(pwd)
ZSTD_SRC=${ZSTD_SRC:-$ROOT/../../zstd-js/deps/zstd}
BROTLI_SRC=${BROTLI_SRC:-$ROOT/../../brotli-js/deps/brotli}
OUT=$ROOT/dist
PLATFORMS=${1:-"ios android"}

ZSTD_FILES="common/debug.c common/entropy_common.c common/error_private.c common/fse_decompress.c common/pool.c common/threading.c common/xxhash.c common/zstd_common.c decompress/huf_decompress.c decompress/zstd_ddict.c decompress/zstd_decompress.c decompress/zstd_decompress_block.c"
BROTLI_FILES="$(cd "$BROTLI_SRC/c" && ls common/*.c dec/*.c)"
CFLAGS_COMMON="-std=c11 -O2 -fPIC -fvisibility=hidden -DNDEBUG -DZSTD_DISABLE_ASM=1 -DZSTD_LEGACY_SUPPORT=0 -DXXH_NAMESPACE=ZSTD_ -DZSTD_MULTITHREAD=0 -I$ZSTD_SRC/lib -I$BROTLI_SRC/c/include -I$ROOT"

build_objs() { # $1 = compiler + flags, $2 = object dir
  mkdir -p "$2"
  for f in $ZSTD_FILES; do $1 -c "$ZSTD_SRC/lib/$f" -o "$2/zstd_$(basename "$f" .c).o"; done
  for f in $BROTLI_FILES; do $1 -c "$BROTLI_SRC/c/$f" -o "$2/brotli_$(echo "$f" | tr / _ | sed 's/\.c$//').o"; done
  $1 -Wall -c "$ROOT/hbcpack.c" -o "$2/hbcpack.o"
  # platform wrapper: Objective-C class on iOS, JNI binding on Android
  case "$1" in
    *apple-ios*) $1 -Wall -fobjc-arc -c "$ROOT/ios/HBCPackKit.m" -o "$2/HBCPackKit.o" ;;
    *linux-android*) $1 -Wall -c "$ROOT/android/hbcpack_jni.c" -o "$2/hbcpack_jni.o" ;;
  esac
}

if echo "$PLATFORMS" | grep -q ios; then
  IOS_MIN=13.0
  DEV_SDK=$(xcrun --sdk iphoneos --show-sdk-path)
  SIM_SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
  rm -rf "$OUT/ios"; mkdir -p "$OUT/ios/headers"
  cp hbcpack.h ios/HBCPackKit.h "$OUT/ios/headers/"
  build_objs "xcrun clang $CFLAGS_COMMON -target arm64-apple-ios$IOS_MIN -isysroot $DEV_SDK" "$OUT/ios/obj-device"
  xcrun libtool -static -o "$OUT/ios/device/libhbcpack.a" "$OUT"/ios/obj-device/*.o 2>/dev/null || { mkdir -p "$OUT/ios/device"; xcrun libtool -static -o "$OUT/ios/device/libhbcpack.a" "$OUT"/ios/obj-device/*.o; }
  build_objs "xcrun clang $CFLAGS_COMMON -target arm64-apple-ios$IOS_MIN-simulator -isysroot $SIM_SDK" "$OUT/ios/obj-sim-arm64"
  build_objs "xcrun clang $CFLAGS_COMMON -target x86_64-apple-ios$IOS_MIN-simulator -isysroot $SIM_SDK" "$OUT/ios/obj-sim-x86_64"
  mkdir -p "$OUT/ios/simulator"
  xcrun libtool -static -o "$OUT/ios/simulator/libhbcpack-arm64.a" "$OUT"/ios/obj-sim-arm64/*.o
  xcrun libtool -static -o "$OUT/ios/simulator/libhbcpack-x86_64.a" "$OUT"/ios/obj-sim-x86_64/*.o
  xcrun lipo -create "$OUT/ios/simulator/libhbcpack-arm64.a" "$OUT/ios/simulator/libhbcpack-x86_64.a" -output "$OUT/ios/simulator/libhbcpack.a"
  rm -rf "$OUT/ios/hbcpack.xcframework"
  xcodebuild -create-xcframework \
    -library "$OUT/ios/device/libhbcpack.a" -headers "$OUT/ios/headers" \
    -library "$OUT/ios/simulator/libhbcpack.a" -headers "$OUT/ios/headers" \
    -output "$OUT/ios/hbcpack.xcframework" >/dev/null
  rm -rf "$OUT"/ios/obj-*
  echo "ios: $OUT/ios/hbcpack.xcframework"
fi

if echo "$PLATFORMS" | grep -q android; then
  NDK=${ANDROID_NDK:-$(ls -d "$HOME"/Library/Android/sdk/ndk/* | sort -V | tail -1)}
  TC=$NDK/toolchains/llvm/prebuilt/darwin-x86_64/bin
  API=${ANDROID_API:-24}
  rm -rf "$OUT/android"
  for abi in arm64-v8a armeabi-v7a x86_64; do
    case $abi in
      arm64-v8a) target=aarch64-linux-android$API; extra="-march=armv8-a+crypto" ;;   # SHA-1 instructions; every arm64 Android device has them
      armeabi-v7a) target=armv7a-linux-androideabi$API; extra="-mfpu=neon -mthumb" ;;
      x86_64) target=x86_64-linux-android$API; extra="" ;;
    esac
    build_objs "$TC/clang $CFLAGS_COMMON --target=$target $extra" "$OUT/android/obj-$abi"
    mkdir -p "$OUT/android/$abi"
    "$TC/llvm-ar" rcs "$OUT/android/$abi/libhbcpack.a" "$OUT"/android/obj-$abi/*.o
    "$TC/clang" --target=$target -shared -Wl,--version-script="$ROOT/hbcpack.map" -o "$OUT/android/$abi/libhbcpack.so" "$OUT"/android/obj-$abi/*.o
    rm -rf "$OUT/android/obj-$abi"
    echo "android/$abi: $(du -h "$OUT/android/$abi/libhbcpack.so" | cut -f1) shared, $(du -h "$OUT/android/$abi/libhbcpack.a" | cut -f1) static"
  done
  cp hbcpack.h "$OUT/android/"
fi
