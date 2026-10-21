// Objective-C (and Swift, via bridging) wrapper for the hbc-pack decoder. Link hbcpack.xcframework.
// (File is HBCPackKit.h because hbcpack.h, the C API, would collide on case-insensitive filesystems.)
//
//   NSData *hbc = [HBCPack unpack:packed dictionaries:nil error:&error];
//   let hbc = try HBCPack.unpack(packed, dictionaries: ["storage": dictData])
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

extern NSErrorDomain const HBCPackErrorDomain;

NS_SWIFT_NAME(HBCPack)
@interface HBCPack : NSObject

/// Decodes an hbc-pack container into the original Hermes bytecode file.
/// `dictionaries` maps stream names (FORMAT.md) to zstd dictionaries; pass nil when none were used.
+ (nullable NSData *)unpack:(NSData *)packed
               dictionaries:(nullable NSDictionary<NSString *, NSData *> *)dictionaries
                      error:(NSError *_Nullable *_Nullable)error;

/// Size of the decoded file, read from the container header without decoding the rest.
+ (NSUInteger)unpackedSize:(NSData *)packed error:(NSError *_Nullable *_Nullable)error;

+ (NSString *)nativeVersion;

@end

NS_ASSUME_NONNULL_END
