# React Native (iOS) build of the hbc-pack decoder: cpp/ (JSI TurboModule) over native/hbcpack.c
# and the bundled zstd decompressor and brotli decoder sources.
require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
zstd = "deps/zstd/lib"
brotli = "deps/brotli/c"

Pod::Spec.new do |s|
  s.name         = "KodespireHbcPack"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/kodespire/hbc-pack.git", :tag => "v#{s.version}" }

  s.source_files = [
    "ios/*.{h,mm}",
    "cpp/*.{h,cpp}",
    "native/hbcpack.{h,c}",
    "native/hbcpack_opcode.h",
    "native/hbcpack_opcodes*.h",
    "native/hbcpack_symbols.h",
    "#{zstd}/*.h",
    "#{zstd}/{common,decompress}/*.{h,c}",
    "#{brotli}/include/brotli/*.h",
    "#{brotli}/{common,dec}/*.{h,c}",
  ]
  # Only the provider is public, so zstd's and brotli's internal headers never shadow another pod's.
  s.public_header_files = "ios/*.h"

  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => "\"$(PODS_TARGET_SRCROOT)/cpp\" \"$(PODS_TARGET_SRCROOT)/native\" " \
                             "\"$(PODS_TARGET_SRCROOT)/#{zstd}\" \"$(PODS_TARGET_SRCROOT)/#{zstd}/common\" " \
                             "\"$(PODS_TARGET_SRCROOT)/#{brotli}/include\"",
    # zstd/brotli symbols are renamed (native/hbcpack_symbols.h) so this pod can coexist with
    # @kodespire/zstd-js and @kodespire/brotli-js, which carry their own copies.
    "OTHER_CFLAGS" => "$(inherited) -include \"$(PODS_TARGET_SRCROOT)/native/hbcpack_symbols.h\"",
    "GCC_PREPROCESSOR_DEFINITIONS" => "$(inherited) ZSTD_LEGACY_SUPPORT=0 ZSTD_DISABLE_ASM ZSTD_NO_TRACE XXH_NAMESPACE=ZSTD_ ZSTD_MULTITHREAD=0",
    "GCC_OPTIMIZATION_LEVEL" => "3",
    "GCC_SYMBOLS_PRIVATE_EXTERN" => "YES",
    "CLANG_WARN_COMMA" => "NO",
    "CLANG_WARN_UNREACHABLE_CODE" => "NO",
  }

  install_modules_dependencies(s)
end
