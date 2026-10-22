#import "HBCPackKit.h"
#include "../hbcpack.h"

NSErrorDomain const HBCPackErrorDomain = @"com.kodespire.hbcpack";

static NSError *HBCPackMakeError(hbcpack_status status) {
  return [NSError errorWithDomain:HBCPackErrorDomain
                             code:status
                         userInfo:@{NSLocalizedDescriptionKey : [NSString stringWithUTF8String:hbcpack_strerror(status)]}];
}

@implementation HBCPack

+ (nullable NSData *)unpack:(NSData *)packed dictionaries:(nullable NSDictionary<NSString *, NSData *> *)dictionaries error:(NSError **)error {
  return [self unpack:packed dictionaries:dictionaries base:nil error:error];
}

+ (nullable NSData *)unpack:(NSData *)packed dictionaries:(nullable NSDictionary<NSString *, NSData *> *)dictionaries base:(nullable NSData *)base error:(NSError **)error {
  NSUInteger n = dictionaries.count;
  hbcpack_dict *dicts = n ? calloc(n, sizeof(hbcpack_dict)) : NULL;
  NSMutableArray<NSString *> *names = [NSMutableArray arrayWithCapacity:n];
  NSUInteger i = 0;
  for (NSString *name in dictionaries) {
    [names addObject:name];
    NSData *d = dictionaries[name];
    dicts[i].name = name.UTF8String;
    dicts[i].data = d.bytes;
    dicts[i].size = d.length;
    i++;
  }
  hbcpack_options opts = {dicts, n, 0, base.bytes, base.length};
  uint8_t *out = NULL;
  size_t outLen = 0;
  hbcpack_status st = hbcpack_unpack(packed.bytes, packed.length, &opts, &out, &outLen);
  free(dicts);
  if (st != HBCPACK_OK) {
    if (error) *error = HBCPackMakeError(st);
    return nil;
  }
  // Takes ownership of the decoder's buffer; freed with hbcpack_free.
  return [[NSData alloc] initWithBytesNoCopy:out length:outLen deallocator:^(void *bytes, NSUInteger length) { (void)length; hbcpack_free(bytes); }];
}

+ (NSUInteger)unpackedSize:(NSData *)packed error:(NSError **)error {
  return [self unpackedSize:packed base:nil error:error];
}

+ (NSUInteger)unpackedSize:(NSData *)packed base:(nullable NSData *)base error:(NSError **)error {
  size_t size = 0;
  hbcpack_options opts = {NULL, 0, 0, base.bytes, base.length};
  hbcpack_status st = hbcpack_unpacked_size(packed.bytes, packed.length, &opts, &size);
  if (st != HBCPACK_OK) {
    if (error) *error = HBCPackMakeError(st);
    return 0;
  }
  return size;
}

+ (NSString *)nativeVersion {
  return @HBCPACK_VERSION;
}

@end
