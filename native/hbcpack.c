/* hbc-pack native decoder: HBC bytecode versions 94, 96, 98 and 99, container versions 2 and 3
 * (delta). See hbcpack.h and ../FORMAT.md. */
#include "hbcpack.h"
#include "hbcpack_opcode.h"
#include "hbcpack_opcodes94.h"
#include "hbcpack_opcodes96.h"
#include "hbcpack_opcodes98.h"
#include "hbcpack_opcodes99.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <brotli/decode.h>
#include <zstd.h>
#include <zstd_errors.h>

#ifdef HBCPACK_PROFILE
#include <time.h>
static double prof_now(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return (double)ts.tv_sec * 1e3 + (double)ts.tv_nsec / 1e6; }
#define PROF_MARK(label) do { double _t = prof_now(); fprintf(stderr, "  %-10s %7.2f ms\n", label, _t - prof_t); prof_t = _t; } while (0)
#define PROF_START() double prof_t = prof_now()
#else
#define PROF_MARK(label) ((void)0)
#define PROF_START() ((void)0)
#endif

#define HEADER_SIZE 128
#define MAX_STREAMS 64
#define DEFAULT_MAX_OUTPUT ((size_t)256 << 20)

/* ------------------------------------------------------------------------------------------ */
/* small helpers                                                                                */

typedef struct { const uint8_t *p; size_t len, pos; } reader;

static int rd_u8(reader *r, uint32_t *v) { if (r->pos >= r->len) return 0; *v = r->p[r->pos++]; return 1; }
static int rd_varint(reader *r, uint64_t *v) {
  uint64_t x = 0; unsigned shift = 0;
  for (;;) {
    if (r->pos >= r->len || shift > 63) return 0;
    uint8_t b = r->p[r->pos++];
    x |= (uint64_t)(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  *v = x; return 1;
}
static int rd_varint32(reader *r, uint32_t *v) { uint64_t x; if (!rd_varint(r, &x) || x > 0xffffffffull) return 0; *v = (uint32_t)x; return 1; }
static int rd_svarint(reader *r, int64_t *v) {
  uint64_t u; if (!rd_varint(r, &u)) return 0;
  *v = (u & 1) ? -(int64_t)((u + 1) >> 1) : (int64_t)(u >> 1); return 1;
}
static int rd_bytes(reader *r, size_t n, const uint8_t **out) {
  if (n > r->len - r->pos) return 0;
  *out = r->p + r->pos; r->pos += n; return 1;
}

static uint32_t ld32(const uint8_t *b) { return (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24); }
static void st32(uint8_t *b, uint32_t v) { b[0] = (uint8_t)v; b[1] = (uint8_t)(v >> 8); b[2] = (uint8_t)(v >> 16); b[3] = (uint8_t)(v >> 24); }
static uint32_t align4(uint32_t n) { return (n + 3u) & ~3u; }

/* ------------------------------------------------------------------------------------------ */
/* SHA-1 (footer)                                                                               */

typedef struct { uint32_t h[5]; uint64_t len; uint8_t buf[64]; size_t n; } sha1_ctx;

/* ARMv8 SHA-1 instructions: always present on Apple arm64; elsewhere only when the build enables
 * them (-march=armv8-a+crypto defines __ARM_FEATURE_SHA2). Otherwise the portable block below. */
#if defined(__aarch64__) && (defined(__APPLE__) || defined(__ARM_FEATURE_SHA2) || defined(__ARM_FEATURE_CRYPTO))
#define HBCPACK_SHA1_ARM 1
#include <arm_neon.h>
static void sha1_block(sha1_ctx *c, const uint8_t *p) {
  uint32x4_t ABCD = vld1q_u32(c->h), ABCD_SAVED = ABCD, TMP0, TMP1, MSG0, MSG1, MSG2, MSG3;
  uint32_t E0 = c->h[4], E0_SAVED = E0, E1;
  MSG0 = vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(p)));
  MSG1 = vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(p + 16)));
  MSG2 = vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(p + 32)));
  MSG3 = vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(p + 48)));
  const uint32x4_t K0 = vdupq_n_u32(0x5a827999), K1 = vdupq_n_u32(0x6ed9eba1), K2 = vdupq_n_u32(0x8f1bbcdc), K3 = vdupq_n_u32(0xca62c1d6);
  TMP0 = vaddq_u32(MSG0, K0); TMP1 = vaddq_u32(MSG1, K0);
  E1 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1cq_u32(ABCD, E0, TMP0); TMP0 = vaddq_u32(MSG2, K0); MSG0 = vsha1su0q_u32(MSG0, MSG1, MSG2);
  E0 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1cq_u32(ABCD, E1, TMP1); TMP1 = vaddq_u32(MSG3, K0); MSG0 = vsha1su1q_u32(MSG0, MSG3); MSG1 = vsha1su0q_u32(MSG1, MSG2, MSG3);
  E1 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1cq_u32(ABCD, E0, TMP0); TMP0 = vaddq_u32(MSG0, K0); MSG1 = vsha1su1q_u32(MSG1, MSG0); MSG2 = vsha1su0q_u32(MSG2, MSG3, MSG0);
  E0 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1cq_u32(ABCD, E1, TMP1); TMP1 = vaddq_u32(MSG1, K1); MSG2 = vsha1su1q_u32(MSG2, MSG1); MSG3 = vsha1su0q_u32(MSG3, MSG0, MSG1);
  E1 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1cq_u32(ABCD, E0, TMP0); TMP0 = vaddq_u32(MSG2, K1); MSG3 = vsha1su1q_u32(MSG3, MSG2); MSG0 = vsha1su0q_u32(MSG0, MSG1, MSG2);
  E0 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1pq_u32(ABCD, E1, TMP1); TMP1 = vaddq_u32(MSG3, K1); MSG0 = vsha1su1q_u32(MSG0, MSG3); MSG1 = vsha1su0q_u32(MSG1, MSG2, MSG3);
  E1 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1pq_u32(ABCD, E0, TMP0); TMP0 = vaddq_u32(MSG0, K1); MSG1 = vsha1su1q_u32(MSG1, MSG0); MSG2 = vsha1su0q_u32(MSG2, MSG3, MSG0);
  E0 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1pq_u32(ABCD, E1, TMP1); TMP1 = vaddq_u32(MSG1, K1); MSG2 = vsha1su1q_u32(MSG2, MSG1); MSG3 = vsha1su0q_u32(MSG3, MSG0, MSG1);
  E1 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1pq_u32(ABCD, E0, TMP0); TMP0 = vaddq_u32(MSG2, K2); MSG3 = vsha1su1q_u32(MSG3, MSG2); MSG0 = vsha1su0q_u32(MSG0, MSG1, MSG2);
  E0 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1pq_u32(ABCD, E1, TMP1); TMP1 = vaddq_u32(MSG3, K2); MSG0 = vsha1su1q_u32(MSG0, MSG3); MSG1 = vsha1su0q_u32(MSG1, MSG2, MSG3);
  E1 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1mq_u32(ABCD, E0, TMP0); TMP0 = vaddq_u32(MSG0, K2); MSG1 = vsha1su1q_u32(MSG1, MSG0); MSG2 = vsha1su0q_u32(MSG2, MSG3, MSG0);
  E0 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1mq_u32(ABCD, E1, TMP1); TMP1 = vaddq_u32(MSG1, K2); MSG2 = vsha1su1q_u32(MSG2, MSG1); MSG3 = vsha1su0q_u32(MSG3, MSG0, MSG1);
  E1 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1mq_u32(ABCD, E0, TMP0); TMP0 = vaddq_u32(MSG2, K2); MSG3 = vsha1su1q_u32(MSG3, MSG2); MSG0 = vsha1su0q_u32(MSG0, MSG1, MSG2);
  E0 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1mq_u32(ABCD, E1, TMP1); TMP1 = vaddq_u32(MSG3, K3); MSG0 = vsha1su1q_u32(MSG0, MSG3); MSG1 = vsha1su0q_u32(MSG1, MSG2, MSG3);
  E1 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1mq_u32(ABCD, E0, TMP0); TMP0 = vaddq_u32(MSG0, K3); MSG1 = vsha1su1q_u32(MSG1, MSG0); MSG2 = vsha1su0q_u32(MSG2, MSG3, MSG0);
  E0 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1pq_u32(ABCD, E1, TMP1); TMP1 = vaddq_u32(MSG1, K3); MSG2 = vsha1su1q_u32(MSG2, MSG1); MSG3 = vsha1su0q_u32(MSG3, MSG0, MSG1);
  E1 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1pq_u32(ABCD, E0, TMP0); TMP0 = vaddq_u32(MSG2, K3); MSG3 = vsha1su1q_u32(MSG3, MSG2);
  E0 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1pq_u32(ABCD, E1, TMP1); TMP1 = vaddq_u32(MSG3, K3);
  E1 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1pq_u32(ABCD, E0, TMP0);
  E0 = vsha1h_u32(vgetq_lane_u32(ABCD, 0)); ABCD = vsha1pq_u32(ABCD, E1, TMP1);
  E0 += E0_SAVED; ABCD = vaddq_u32(ABCD_SAVED, ABCD);
  vst1q_u32(c->h, ABCD); c->h[4] = E0;
}
#else
static uint32_t rol(uint32_t x, int s) { return (x << s) | (x >> (32 - s)); }
static void sha1_block(sha1_ctx *c, const uint8_t *p) {
  uint32_t w[80];
  for (int i = 0; i < 16; i++) w[i] = ((uint32_t)p[4 * i] << 24) | ((uint32_t)p[4 * i + 1] << 16) | ((uint32_t)p[4 * i + 2] << 8) | p[4 * i + 3];
  for (int i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
  uint32_t a = c->h[0], b = c->h[1], cc = c->h[2], d = c->h[3], e = c->h[4];
  for (int i = 0; i < 80; i++) {
    uint32_t f, k;
    if (i < 20) { f = (b & cc) | (~b & d); k = 0x5a827999; }
    else if (i < 40) { f = b ^ cc ^ d; k = 0x6ed9eba1; }
    else if (i < 60) { f = (b & cc) | (b & d) | (cc & d); k = 0x8f1bbcdc; }
    else { f = b ^ cc ^ d; k = 0xca62c1d6; }
    uint32_t t = rol(a, 5) + f + e + k + w[i];
    e = d; d = cc; cc = rol(b, 30); b = a; a = t;
  }
  c->h[0] += a; c->h[1] += b; c->h[2] += cc; c->h[3] += d; c->h[4] += e;
}
#endif
static void sha1_init(sha1_ctx *c) { c->h[0] = 0x67452301; c->h[1] = 0xefcdab89; c->h[2] = 0x98badcfe; c->h[3] = 0x10325476; c->h[4] = 0xc3d2e1f0; c->len = 0; c->n = 0; }
static void sha1_update(sha1_ctx *c, const uint8_t *p, size_t n) {
  c->len += n;
  if (c->n) { size_t take = 64 - c->n; if (take > n) take = n; memcpy(c->buf + c->n, p, take); c->n += take; p += take; n -= take; if (c->n == 64) { sha1_block(c, c->buf); c->n = 0; } }
  while (n >= 64) { sha1_block(c, p); p += 64; n -= 64; }
  if (n) { memcpy(c->buf, p, n); c->n = n; }
}
static void sha1_final(sha1_ctx *c, uint8_t out[20]) {
  uint64_t bits = c->len * 8; uint8_t pad = 0x80; sha1_update(c, &pad, 1);
  uint8_t zero = 0; while (c->n != 56) sha1_update(c, &zero, 1);
  uint8_t len[8]; for (int i = 0; i < 8; i++) len[i] = (uint8_t)(bits >> (56 - 8 * i)); sha1_update(c, len, 8);
  for (int i = 0; i < 5; i++) { out[4 * i] = (uint8_t)(c->h[i] >> 24); out[4 * i + 1] = (uint8_t)(c->h[i] >> 16); out[4 * i + 2] = (uint8_t)(c->h[i] >> 8); out[4 * i + 3] = (uint8_t)c->h[i]; }
}

/* ------------------------------------------------------------------------------------------ */
/* string id -> rank map, reset per function body with a generation counter                     */

typedef struct { uint32_t *key, *val, *gen; uint32_t cap, count, cur; } rankmap;
static int rm_init(rankmap *m, uint32_t cap) {
  m->cap = cap; m->count = 0; m->cur = 1;
  m->key = (uint32_t *)malloc(cap * sizeof(uint32_t)); m->val = (uint32_t *)malloc(cap * sizeof(uint32_t)); m->gen = (uint32_t *)calloc(cap, sizeof(uint32_t));
  return m->key && m->val && m->gen;
}
static void rm_free(rankmap *m) { free(m->key); free(m->val); free(m->gen); }
static void rm_reset(rankmap *m) { m->count = 0; m->cur++; if (m->cur == 0) { memset(m->gen, 0, m->cap * sizeof(uint32_t)); m->cur = 1; } }
static int rm_grow(rankmap *m) {
  rankmap n; if (!rm_init(&n, m->cap * 2)) return 0;
  for (uint32_t i = 0; i < m->cap; i++) if (m->gen[i] == m->cur) {
    uint32_t h = (m->key[i] * 2654435761u) & (n.cap - 1);
    while (n.gen[h] == 1) h = (h + 1) & (n.cap - 1);
    n.key[h] = m->key[i]; n.val[h] = m->val[i]; n.gen[h] = 1;
  }
  n.count = m->count; rm_free(m); *m = n; return 1;
}
static int rm_rank(rankmap *m, uint32_t key, uint32_t *rank) {
  if (m->count * 2 >= m->cap && !rm_grow(m)) return 0;
  uint32_t h = (key * 2654435761u) & (m->cap - 1);
  for (;;) {
    if (m->gen[h] != m->cur) { m->gen[h] = m->cur; m->key[h] = key; m->val[h] = m->count; *rank = m->count++; return 1; }
    if (m->key[h] == key) { *rank = m->val[h]; return 1; }
    h = (h + 1) & (m->cap - 1);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* version profiles                                                                             */

/* Function header, union of both versions' fields. */
typedef struct {
  uint32_t offset, infoOffset, paramCount, loopDepth, size, functionName, numberRegs, nonPtrRegs, frameSize, environmentSize;
  uint8_t readCache, writeCache, numCacheNewObject, privateNameCache, flags;
} fheader;

enum { F_PARAM, F_LOOP, F_NUMREG, F_NONPTR, F_RCACHE, F_WCACHE, F_FLAGS, F_PRIVATE, F_NEWOBJ, F_SIZE, F_NAME, F_FRAME, F_ENV };
typedef struct { uint8_t field, varint; } column;

/* Column order must match profiles.mjs. */
static const column COLS98[] = { {F_PARAM, 0}, {F_LOOP, 0}, {F_NUMREG, 0}, {F_NONPTR, 0}, {F_RCACHE, 0}, {F_WCACHE, 0}, {F_FLAGS, 0}, {F_PRIVATE, 0}, {F_NEWOBJ, 0}, {F_SIZE, 1}, {F_NAME, 1}, {F_FRAME, 1} };
static const column COLS96[] = { {F_RCACHE, 0}, {F_WCACHE, 0}, {F_FLAGS, 0}, {F_PARAM, 1}, {F_SIZE, 1}, {F_NAME, 1}, {F_FRAME, 1}, {F_ENV, 1} };
static const column COLS99[] = { {F_PARAM, 0}, {F_LOOP, 0}, {F_NUMREG, 0}, {F_NONPTR, 0}, {F_RCACHE, 0}, {F_WCACHE, 0}, {F_FLAGS, 0}, {F_PRIVATE, 0}, {F_SIZE, 1}, {F_NAME, 1}, {F_FRAME, 1} };

typedef struct {
  uint32_t version;
  const hbcpack_opcode *ops;
  const column *cols; int ncols;
  uint32_t small_fh, large_fh, debug_offsets;
  int third_is_count;                       /* header[88]: 98 = shape table count (x8), 96 = value buffer bytes */
  int off_cjs, off_funcsrc, off_debuginfo;  /* header offsets */
  int info_always;                          /* 96: every function gets an infoOffset */
} profile;

static const profile PROFILE98 = { 98, HBCPACK_OPCODES98, COLS98, 12, 12, 40, 4, 1, 100, 104, 108, 0 };
static const profile PROFILE96 = { 96, HBCPACK_OPCODES96, COLS96, 8, 16, 32, 8, 0, 96, 100, 104, 1 };
static const profile PROFILE94 = { 94, HBCPACK_OPCODES94, COLS96, 8, 16, 32, 8, 0, 96, 100, 104, 1 }; /* same layout as 96 */
static const profile PROFILE99 = { 99, HBCPACK_OPCODES99, COLS99, 11, 12, 36, 4, 1, 100, 104, 108, 0 };

static void set_field(fheader *f, int field, uint32_t v) {
  switch (field) {
    case F_PARAM: f->paramCount = v; break; case F_LOOP: f->loopDepth = v; break; case F_NUMREG: f->numberRegs = v; break; case F_NONPTR: f->nonPtrRegs = v; break;
    case F_RCACHE: f->readCache = (uint8_t)v; break; case F_WCACHE: f->writeCache = (uint8_t)v; break; case F_FLAGS: f->flags = (uint8_t)v; break;
    case F_PRIVATE: f->privateNameCache = (uint8_t)v; break; case F_NEWOBJ: f->numCacheNewObject = (uint8_t)v; break; case F_SIZE: f->size = v; break;
    case F_NAME: f->functionName = v; break; case F_FRAME: f->frameSize = v; break; case F_ENV: f->environmentSize = v; break;
  }
}

static int fits_small(const profile *P, const fheader *f) {
  if (P->version == 98)
    return f->offset < (1u << 25) && f->paramCount < 32 && f->loopDepth < 4 && f->size < (1u << 14) && f->functionName < 256 && f->numberRegs < 32 &&
           f->nonPtrRegs < 32 && f->frameSize < 256 && f->writeCache < 64 && f->numCacheNewObject < 2 && f->privateNameCache < 2;
  if (P->version == 99)
    return f->offset < (1u << 25) && f->paramCount < 32 && f->loopDepth < 4 && f->size < (1u << 14) && f->functionName < 256 && f->numberRegs < 32 &&
           f->nonPtrRegs < 32 && f->frameSize < 256 && f->writeCache < 128 && f->privateNameCache < 2;
  return f->offset < (1u << 25) && f->paramCount < 128 && f->size < (1u << 15) && f->functionName < (1u << 17) && f->infoOffset < (1u << 25) && f->frameSize < 128 &&
         f->environmentSize < 256;
}

static void encode_small(const profile *P, const fheader *f, uint8_t *sh) {
  if (P->version == 98 || P->version == 99) {
    st32(sh, f->offset | (f->paramCount << 25) | (f->loopDepth << 30));
    st32(sh + 4, f->size | (f->functionName << 14) | (f->numberRegs << 22) | (f->nonPtrRegs << 27));
    sh[8] = (uint8_t)f->frameSize; sh[9] = f->readCache;
    sh[10] = P->version == 98 ? (uint8_t)(f->writeCache | (f->numCacheNewObject << 6) | (f->privateNameCache << 7)) : (uint8_t)(f->writeCache | (f->privateNameCache << 7));
    sh[11] = f->flags;
  } else {
    st32(sh, f->offset | (f->paramCount << 25)); st32(sh + 4, f->size | (f->functionName << 15)); st32(sh + 8, f->infoOffset | (f->frameSize << 25));
    sh[12] = (uint8_t)f->environmentSize; sh[13] = f->readCache; sh[14] = f->writeCache; sh[15] = f->flags;
  }
}

/* The small header of a function whose header lives in the info section. */
static void encode_pointer_small(const profile *P, const fheader *f, uint32_t large_off, uint8_t *sh) {
  if (P->version == 98 || P->version == 99) {
    memset(sh, 0, 12);
    st32(sh, large_off & 0xffffff); st32(sh + 4, ((large_off >> 24) & 0xff) << 14); sh[11] = 0x20;
    return;
  }
  /* v96: fields are copied in order until the first one that does not fit, then offset/infoOffset
   * become the pointer and the overflowed flag is set. */
  fheader s; memset(&s, 0, sizeof s); s.flags = (uint8_t)(f->flags | 0x20);
  const uint32_t vals[9] = { f->offset, f->paramCount, f->size, f->functionName, f->infoOffset, f->frameSize, f->environmentSize, f->readCache, f->writeCache };
  const uint32_t bits[9] = { 25, 7, 15, 17, 25, 7, 8, 8, 8 };
  for (int i = 0; i < 9; i++) {
    if (vals[i] > ((1u << bits[i]) - 1)) break;
    switch (i) {
      case 0: s.offset = vals[i]; break; case 1: s.paramCount = vals[i]; break; case 2: s.size = vals[i]; break; case 3: s.functionName = vals[i]; break;
      case 4: s.infoOffset = vals[i]; break; case 5: s.frameSize = vals[i]; break; case 6: s.environmentSize = vals[i]; break;
      case 7: s.readCache = (uint8_t)vals[i]; break; default: s.writeCache = (uint8_t)vals[i]; break;
    }
  }
  s.offset = large_off & 0xffff; s.infoOffset = large_off >> 16;
  encode_small(P, &s, sh);
}

static void encode_large(const profile *P, const fheader *f, uint8_t *lh) {
  if (P->version == 98) {
    st32(lh, f->offset); st32(lh + 4, f->paramCount); st32(lh + 8, f->loopDepth); st32(lh + 12, f->size); st32(lh + 16, f->functionName);
    st32(lh + 20, f->numberRegs); st32(lh + 24, f->nonPtrRegs); st32(lh + 28, f->frameSize);
    lh[32] = f->readCache; lh[33] = f->writeCache; lh[34] = f->numCacheNewObject; lh[35] = f->privateNameCache; lh[36] = f->flags; lh[37] = lh[38] = lh[39] = 0;
  } else if (P->version == 99) {
    st32(lh, f->offset); st32(lh + 4, f->paramCount); st32(lh + 8, f->loopDepth); st32(lh + 12, f->size); st32(lh + 16, f->functionName);
    st32(lh + 20, f->numberRegs); st32(lh + 24, f->nonPtrRegs); st32(lh + 28, f->frameSize);
    lh[32] = f->readCache; lh[33] = f->writeCache; lh[34] = f->privateNameCache; lh[35] = f->flags;
  } else {
    st32(lh, f->offset); st32(lh + 4, f->paramCount); st32(lh + 8, f->size); st32(lh + 12, f->functionName); st32(lh + 16, f->infoOffset);
    st32(lh + 20, f->frameSize); st32(lh + 24, f->environmentSize); lh[28] = f->readCache; lh[29] = f->writeCache; lh[30] = f->flags; lh[31] = 0;
  }
}

/* zstd reports errors as size_t codes; ZSTD_getErrorCode is used rather than ZSTD_isError because
 * the latter is a macro inside zstd's own sources (see deps/zstd/PATCHES.md). */
static int zstd_ok(size_t n) { return ZSTD_getErrorCode(n) == ZSTD_error_no_error; }

/* Stream positions (FORMAT.md, container versions 2 and 3). */
enum { S_HEADER = 0, S_KINDS, S_STRFLAGS, S_STRLENS, S_STRDELTAS, S_STORAGE, S_ARRAYBUF, S_OBJKEYBUF, S_THIRD, S_MISC, S_PADDING, S_DEBUG, S_FIXED_COUNT };
enum { TAIL_REUSE = 0, TAIL_EXCCOUNT, TAIL_EXCSTART, TAIL_EXCEND, TAIL_EXCTARGET, TAIL_DEBUGOFF, TAIL_OPCODES, TAIL_OPERANDS /* 16 */, TAIL_SWITCH = TAIL_OPERANDS + 16, TAIL_CACHERES, TAIL_COUNT };
static const char *const FIXED_NAMES[S_FIXED_COUNT] = { "header", "kinds", "strFlags", "strLens", "strDeltas", "storage", "arrayBuffer", "objKeyBuffer", "literalTable3", "misc", "padding", "debug" };
static const char *const TAIL_NAMES[TAIL_COUNT] = { "fhReuse", "excCount", "excStart", "excEnd", "excTarget", "debugOff", "opcodes",
  "reg8", "reg32", "u8", "u16", "u32", "str8", "str16", "str32", "fn16", "fn32", "bi16", "bi32", "addr8", "addr32", "imm32", "dbl64", "switchTables", "cacheRes" };
static const char *const FIELD_NAMES[] = { "paramCount", "loopDepth", "numberRegCount", "nonPtrRegCount", "readCacheSize", "writeCacheSize", "flagsByte", "privateNameCacheSize", "numCacheNewObject", "bytecodeSize", "functionName", "frameSize", "environmentSize" };
/* Operand streams holding string ids: u32 canonical ids in delta containers. */
#define IS_ID_STREAM(k) ((k) == 5 || (k) == 6 || (k) == 7)

typedef struct { uint8_t *data; size_t len; } stream;
typedef struct { stream s[MAX_STREAMS]; int count; } streams;

static void free_streams(streams *st) { for (int i = 0; i < MAX_STREAMS; i++) { free(st->s[i].data); st->s[i].data = NULL; } st->count = 0; }

/* ------------------------------------------------------------------------------------------ */
/* HBC header and table layout                                                                  */

typedef struct {
  const profile *P;
  uint32_t fileLength, functionCount, stringKindCount, identifierCount, stringCount, overflowStringCount, stringStorageSize,
           bigIntCount, bigIntStorageSize, regExpCount, regExpStorageSize, arrayBufferSize, objKeyBufferSize, third,
           cjsModuleCount, functionSourceCount, debugInfoOffset;
} hbc_header;

enum { T_FUNCHEADERS, T_KINDS, T_HASHES, T_STRTABLE, T_OVERFLOW, T_STORAGE, T_ARRAY, T_OBJKEY, T_THIRD, T_BIGINT, T_BIGINTSTORE,
       T_REGEXP, T_REGEXPSTORE, T_CJS, T_FUNCSOURCE, T_COUNT };
typedef struct { uint32_t start, size; } section;

static int parse_header(const stream *hs, hbc_header *h) {
  static const uint8_t MAGIC[8] = { 0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f };
  if (hs->len != HEADER_SIZE || memcmp(hs->data, MAGIC, 8) != 0) return 0;
  const uint8_t *b = hs->data;
  uint32_t version = ld32(b + 8);
  h->P = version == 98 ? &PROFILE98 : version == 99 ? &PROFILE99 : version == 96 ? &PROFILE96 : version == 94 ? &PROFILE94 : NULL;
  if (!h->P) return 0;
  h->fileLength = ld32(b + 32); h->functionCount = ld32(b + 40); h->stringKindCount = ld32(b + 44); h->identifierCount = ld32(b + 48);
  h->stringCount = ld32(b + 52); h->overflowStringCount = ld32(b + 56); h->stringStorageSize = ld32(b + 60); h->bigIntCount = ld32(b + 64);
  h->bigIntStorageSize = ld32(b + 68); h->regExpCount = ld32(b + 72); h->regExpStorageSize = ld32(b + 76); h->arrayBufferSize = ld32(b + 80);
  h->objKeyBufferSize = ld32(b + 84); h->third = ld32(b + 88);
  h->cjsModuleCount = ld32(b + h->P->off_cjs); h->functionSourceCount = ld32(b + h->P->off_funcsrc); h->debugInfoOffset = ld32(b + h->P->off_debuginfo);
  return 1;
}

static int layout(const hbc_header *h, section *t, uint32_t *tables_end) {
  uint64_t o = HEADER_SIZE;
  const uint64_t sizes[T_COUNT] = {
    (uint64_t)h->P->small_fh * h->functionCount, 4ull * h->stringKindCount, 4ull * h->identifierCount, 4ull * h->stringCount,
    8ull * h->overflowStringCount, h->stringStorageSize, h->arrayBufferSize, h->objKeyBufferSize, h->P->third_is_count ? 8ull * h->third : h->third,
    8ull * h->bigIntCount, h->bigIntStorageSize, 8ull * h->regExpCount, h->regExpStorageSize, 8ull * h->cjsModuleCount, 8ull * h->functionSourceCount,
  };
  for (int i = 0; i < T_COUNT; i++) {
    o = (o + 3) & ~3ull;
    if (o + sizes[i] > h->fileLength) return 0;
    t[i].start = (uint32_t)o; t[i].size = (uint32_t)sizes[i]; o += sizes[i];
  }
  o = (o + 3) & ~3ull;
  if (o > h->fileLength) return 0;
  *tables_end = (uint32_t)o;
  return 1;
}

/* ------------------------------------------------------------------------------------------ */
/* growable byte buffer (stream writer)                                                         */

typedef struct { uint8_t *p; size_t len, cap; } wbuf;
static int wb_reserve(wbuf *w, size_t extra) {
  if (w->len + extra <= w->cap) return 1;
  size_t cap = w->cap ? w->cap : 256;
  while (cap < w->len + extra) cap *= 2;
  uint8_t *np = (uint8_t *)realloc(w->p, cap);
  if (!np) return 0;
  w->p = np; w->cap = cap; return 1;
}
static int wb_u8(wbuf *w, uint32_t v) { if (!wb_reserve(w, 1)) return 0; w->p[w->len++] = (uint8_t)v; return 1; }
static int wb_u32(wbuf *w, uint32_t v) { if (!wb_reserve(w, 4)) return 0; st32(w->p + w->len, v); w->len += 4; return 1; }
static int wb_bytes(wbuf *w, const uint8_t *b, size_t n) { if (!wb_reserve(w, n)) return 0; memcpy(w->p + w->len, b, n); w->len += n; return 1; }
static int wb_varint(wbuf *w, uint64_t v) {
  if (!wb_reserve(w, 10)) return 0;
  while (v >= 0x80) { w->p[w->len++] = (uint8_t)(v | 0x80); v >>= 7; }
  w->p[w->len++] = (uint8_t)v; return 1;
}
static int wb_svarint(wbuf *w, int64_t v) { return wb_varint(w, v < 0 ? (uint64_t)(-v) * 2 - 1 : (uint64_t)v * 2); }

/* Small/large header decoding (inverse of encode_small / encode_large). */
static void decode_small(const profile *P, const uint8_t *b, fheader *f, uint32_t *large_off) {
  memset(f, 0, sizeof *f);
  uint32_t w1 = ld32(b), w2 = ld32(b + 4);
  if (P->version == 98 || P->version == 99) {
    f->offset = w1 & 0x1ffffff; f->paramCount = (w1 >> 25) & 31; f->loopDepth = w1 >> 30;
    f->size = w2 & 0x3fff; f->functionName = (w2 >> 14) & 0xff; f->numberRegs = (w2 >> 22) & 31; f->nonPtrRegs = w2 >> 27;
    f->frameSize = b[8]; f->readCache = b[9];
    if (P->version == 98) { f->writeCache = b[10] & 63; f->numCacheNewObject = (b[10] >> 6) & 1; f->privateNameCache = b[10] >> 7; }
    else { f->writeCache = b[10] & 127; f->privateNameCache = b[10] >> 7; }
    f->flags = b[11];
    *large_off = (f->functionName << 24) | f->offset;
  } else {
    uint32_t w3 = ld32(b + 8);
    f->offset = w1 & 0x1ffffff; f->paramCount = w1 >> 25; f->size = w2 & 0x7fff; f->functionName = w2 >> 15;
    f->infoOffset = w3 & 0x1ffffff; f->frameSize = w3 >> 25; f->environmentSize = b[12]; f->readCache = b[13]; f->writeCache = b[14]; f->flags = b[15];
    *large_off = (f->infoOffset << 16) | f->offset;
  }
}
static void decode_large(const profile *P, const uint8_t *b, fheader *f) {
  memset(f, 0, sizeof *f);
  if (P->version == 98 || P->version == 99) {
    f->offset = ld32(b); f->paramCount = ld32(b + 4); f->loopDepth = ld32(b + 8); f->size = ld32(b + 12); f->functionName = ld32(b + 16);
    f->numberRegs = ld32(b + 20); f->nonPtrRegs = ld32(b + 24); f->frameSize = ld32(b + 28); f->readCache = b[32]; f->writeCache = b[33];
    if (P->version == 98) { f->numCacheNewObject = b[34]; f->privateNameCache = b[35]; f->flags = b[36]; }
    else { f->privateNameCache = b[34]; f->flags = b[35]; }
  } else {
    f->offset = ld32(b); f->paramCount = ld32(b + 4); f->size = ld32(b + 8); f->functionName = ld32(b + 12); f->infoOffset = ld32(b + 16);
    f->frameSize = ld32(b + 20); f->environmentSize = ld32(b + 24); f->readCache = b[28]; f->writeCache = b[29]; f->flags = b[30];
  }
}
static uint32_t get_field(const fheader *f, int field) {
  switch (field) {
    case F_PARAM: return f->paramCount; case F_LOOP: return f->loopDepth; case F_NUMREG: return f->numberRegs; case F_NONPTR: return f->nonPtrRegs;
    case F_RCACHE: return f->readCache; case F_WCACHE: return f->writeCache; case F_FLAGS: return f->flags; case F_PRIVATE: return f->privateNameCache;
    case F_NEWOBJ: return f->numCacheNewObject; case F_SIZE: return f->size; case F_NAME: return f->functionName; case F_FRAME: return f->frameSize;
    default: return f->environmentSize;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* base file -> streams (delta containers)                                                      */

typedef struct { stream s[MAX_STREAMS]; int count; char names[MAX_STREAMS][33]; const profile *P;
                 /* the base's strings, for the id map */
                 uint32_t string_count; uint32_t *str_off; uint32_t *str_len; uint8_t *str_utf16; const uint8_t *storage; } base_streams;

static void free_base(base_streams *b) { for (int i = 0; i < MAX_STREAMS; i++) { free(b->s[i].data); b->s[i].data = NULL; } free(b->str_off); free(b->str_len); free(b->str_utf16); memset(b, 0, sizeof *b); }

static void stream_name(const profile *P, int index, char out[33]) {
  if (index < S_FIXED_COUNT) snprintf(out, 33, "%s", FIXED_NAMES[index]);
  else if (index < S_FIXED_COUNT + P->ncols) snprintf(out, 33, "fh:%s", FIELD_NAMES[P->cols[index - S_FIXED_COUNT].field]);
  else snprintf(out, 33, "%s", TAIL_NAMES[index - S_FIXED_COUNT - P->ncols]);
}

/* uint64 -> uint32 open-addressing map (body dedup). */
typedef struct { uint64_t *key; uint32_t *val; uint8_t *used; uint32_t cap; } u64map;
static int um_init(u64map *m, uint32_t n) { m->cap = 64; while (m->cap < n * 2) m->cap *= 2; m->key = (uint64_t *)malloc(m->cap * 8); m->val = (uint32_t *)malloc(m->cap * 4); m->used = (uint8_t *)calloc(m->cap, 1); return m->key && m->val && m->used; }
static void um_free(u64map *m) { free(m->key); free(m->val); free(m->used); }
static uint32_t *um_slot(u64map *m, uint64_t k, int *found) {
  uint32_t h = (uint32_t)((k ^ (k >> 29)) * 2654435761u) & (m->cap - 1);
  for (;;) { if (!m->used[h]) { m->used[h] = 1; m->key[h] = k; *found = 0; return &m->val[h]; } if (m->key[h] == k) { *found = 1; return &m->val[h]; } h = (h + 1) & (m->cap - 1); }
}

#define XFAIL(code) do { status = (code); goto done; } while (0)

/* Takes an .hbc apart into the streams the encoder produces for a delta container (string ids as
 * u32, identity numbering). Mirrors src/codec.mjs extractStreams(buf, {delta: true}). */
static hbcpack_status extract_base(const uint8_t *buf, size_t len, base_streams *B) {
  hbcpack_status status = HBCPACK_OK;
  memset(B, 0, sizeof *B);
  hbc_header h; section t[T_COUNT]; uint32_t tables_end;
  stream hs = { (uint8_t *)buf, HEADER_SIZE };
  if (len < HEADER_SIZE + 20 || !parse_header(&hs, &h) || h.fileLength != len) return HBCPACK_ERR_BASE;
  const profile *P = h.P; B->P = P;
  if (!layout(&h, t, &tables_end) || h.debugInfoOffset < tables_end || h.debugInfoOffset + 20 > len) return HBCPACK_ERR_BASE;
  const int nstreams = S_FIXED_COUNT + P->ncols + TAIL_COUNT;
  wbuf W[MAX_STREAMS]; memset(W, 0, sizeof W);
  fheader *fh = NULL; uint32_t *large_at = NULL; u64map bodies = {0}; rankmap rr = {0}, wr = {0};
  const uint32_t n = h.functionCount;
#define PUT(i, call) do { if (!(call)) XFAIL(HBCPACK_ERR_ALLOC); (void)(i); } while (0)
  /* fixed streams */
  PUT(0, wb_bytes(&W[S_HEADER], buf, HEADER_SIZE));
  PUT(0, wb_bytes(&W[S_KINDS], buf + t[T_KINDS].start, t[T_KINDS].size));
  PUT(0, wb_bytes(&W[S_STORAGE], buf + t[T_STORAGE].start, t[T_STORAGE].size));
  PUT(0, wb_bytes(&W[S_ARRAYBUF], buf + t[T_ARRAY].start, t[T_ARRAY].size));
  PUT(0, wb_bytes(&W[S_OBJKEYBUF], buf + t[T_OBJKEY].start, t[T_OBJKEY].size));
  PUT(0, wb_bytes(&W[S_THIRD], buf + t[T_THIRD].start, t[T_THIRD].size));
  for (int i = T_BIGINT; i < T_COUNT; i++) PUT(0, wb_bytes(&W[S_MISC], buf + t[i].start, t[i].size));
  { uint32_t o = HEADER_SIZE; for (int i = 0; i < T_COUNT; i++) { PUT(0, wb_bytes(&W[S_PADDING], buf + o, t[i].start - o)); o = t[i].start + t[i].size; } PUT(0, wb_bytes(&W[S_PADDING], buf + o, tables_end - o)); }
  PUT(0, wb_bytes(&W[S_DEBUG], buf + h.debugInfoOffset, len - 20 - h.debugInfoOffset));
  /* strings: flags, lengths, deltas; keep offsets for the id map */
  B->string_count = h.stringCount; B->storage = buf + t[T_STORAGE].start;
  B->str_off = (uint32_t *)malloc(((size_t)h.stringCount + 1) * 4); B->str_len = (uint32_t *)malloc(((size_t)h.stringCount + 1) * 4); B->str_utf16 = (uint8_t *)malloc(h.stringCount + 1);
  if (!B->str_off || !B->str_len || !B->str_utf16) XFAIL(HBCPACK_ERR_ALLOC);
  {
    uint32_t si = 0;
    for (uint32_t k = 0; k < h.stringKindCount; k++) {
      uint32_t run = ld32(buf + t[T_KINDS].start + 4 * k) & 0x7fffffff;
      uint64_t prev = 0;
      for (uint32_t j = 0; j < run; j++, si++) {
        if (si >= h.stringCount) XFAIL(HBCPACK_ERR_BASE);
        uint32_t e = ld32(buf + t[T_STRTABLE].start + 4 * si);
        uint32_t utf16 = e & 1, field = (e >> 1) & 0x7fffff, length = e >> 24, offset = field;
        if (length == 255) { if (field >= h.overflowStringCount) XFAIL(HBCPACK_ERR_BASE); offset = ld32(buf + t[T_OVERFLOW].start + 8 * field); length = ld32(buf + t[T_OVERFLOW].start + 8 * field + 4); }
        uint64_t bytes = (uint64_t)length * (utf16 ? 2 : 1);
        if (offset + bytes > h.stringStorageSize) XFAIL(HBCPACK_ERR_BASE);
        B->str_off[si] = offset; B->str_len[si] = length; B->str_utf16[si] = (uint8_t)utf16;
        PUT(0, wb_u8(&W[S_STRFLAGS], utf16)); PUT(0, wb_varint(&W[S_STRLENS], length)); PUT(0, wb_svarint(&W[S_STRDELTAS], (int64_t)offset - (int64_t)prev));
        prev = offset + bytes;
      }
    }
    if (si != h.stringCount) XFAIL(HBCPACK_ERR_BASE);
  }
  /* function headers */
  fh = (fheader *)calloc(n ? n : 1, sizeof(fheader)); large_at = (uint32_t *)malloc(((size_t)n + 1) * 4);
  if (!fh || !large_at) XFAIL(HBCPACK_ERR_ALLOC);
  for (uint32_t i = 0; i < n; i++) {
    const uint8_t *sh = buf + t[T_FUNCHEADERS].start + P->small_fh * i;
    uint32_t large_off; fheader small; decode_small(P, sh, &small, &large_off);
    if ((small.flags >> 5) & 1) {
      if ((uint64_t)large_off + P->large_fh > len) XFAIL(HBCPACK_ERR_BASE);
      decode_large(P, buf + large_off, &fh[i]); large_at[i] = large_off;
      if ((fh[i].flags >> 5) & 1) XFAIL(HBCPACK_ERR_BASE);
    } else { fh[i] = small; large_at[i] = UINT32_MAX; }
  }
  /* columns (+ reuse), exceptions, debug offsets */
  if (!um_init(&bodies, n)) XFAIL(HBCPACK_ERR_ALLOC);
  for (uint32_t i = 0; i < n; i++) {
    const fheader *f = &fh[i];
    for (int c = 0; c < P->ncols; c++) {
      uint32_t v = get_field(f, P->cols[c].field);
      if (P->cols[c].varint) PUT(0, wb_varint(&W[S_FIXED_COUNT + c], v)); else { if (v > 255) XFAIL(HBCPACK_ERR_BASE); PUT(0, wb_u8(&W[S_FIXED_COUNT + c], v)); }
    }
    int found; uint32_t *slot = um_slot(&bodies, ((uint64_t)f->offset << 32) | f->size, &found);
    if (found) PUT(0, wb_varint(&W[S_FIXED_COUNT + P->ncols + TAIL_REUSE], i - *slot)); else { *slot = i; PUT(0, wb_varint(&W[S_FIXED_COUNT + P->ncols + TAIL_REUSE], 0)); }
    int has_exc = (f->flags >> 3) & 1, has_dbg = (f->flags >> 4) & 1;
    if (has_exc || has_dbg) {
      uint64_t p;
      if (P->info_always) { p = (large_at[i] != UINT32_MAX ? large_at[i] + P->large_fh : f->infoOffset); }
      else { if (large_at[i] == UINT32_MAX) XFAIL(HBCPACK_ERR_BASE); p = (uint64_t)large_at[i] + P->large_fh; }
      if (has_exc) {
        if (p + 4 > len) XFAIL(HBCPACK_ERR_BASE);
        uint32_t count = ld32(buf + p); p += 4;
        if (p + 12ull * count > len) XFAIL(HBCPACK_ERR_BASE);
        PUT(0, wb_varint(&W[S_FIXED_COUNT + P->ncols + TAIL_EXCCOUNT], count));
        int64_t prev_start = 0;
        for (uint32_t e = 0; e < count; e++, p += 12) {
          int64_t a = ld32(buf + p), b = ld32(buf + p + 4), c = ld32(buf + p + 8);
          PUT(0, wb_svarint(&W[S_FIXED_COUNT + P->ncols + TAIL_EXCSTART], a - prev_start)); PUT(0, wb_svarint(&W[S_FIXED_COUNT + P->ncols + TAIL_EXCEND], b - a)); PUT(0, wb_svarint(&W[S_FIXED_COUNT + P->ncols + TAIL_EXCTARGET], c - b));
          prev_start = a;
        }
      }
      if (has_dbg) { if (p + P->debug_offsets > len) XFAIL(HBCPACK_ERR_BASE); PUT(0, wb_bytes(&W[S_FIXED_COUNT + P->ncols + TAIL_DEBUGOFF], buf + p, P->debug_offsets)); }
    }
  }
  /* bodies: instructions into opcode + operand streams, cache residuals, switch tables */
  if (!rm_init(&rr, 1024) || !rm_init(&wr, 1024)) XFAIL(HBCPACK_ERR_ALLOC);
  {
    wbuf *ops = &W[S_FIXED_COUNT + P->ncols + TAIL_OPCODES], *opnd = &W[S_FIXED_COUNT + P->ncols + TAIL_OPERANDS], *sw = &W[S_FIXED_COUNT + P->ncols + TAIL_SWITCH], *cres = &W[S_FIXED_COUNT + P->ncols + TAIL_CACHERES];
    uint64_t loc = tables_end;
    for (uint32_t i = 0; i < n; i++) {
      const fheader *f = &fh[i];
      int found; uint32_t *slot = um_slot(&bodies, ((uint64_t)f->offset << 32) | f->size, &found);
      if (!found || *slot != i) continue; /* reused body */
      if (f->offset != loc) XFAIL(HBCPACK_ERR_BASE);
      uint64_t end = loc + f->size; if (end > len) XFAIL(HBCPACK_ERR_BASE);
      uint32_t table_bytes = 0, switch_min = 0;
      rm_reset(&rr); rm_reset(&wr);
      while (loc < end) {
        uint32_t opcode = buf[loc]; const hbcpack_opcode *d = &P->ops[opcode];
        if (!d->name) XFAIL(HBCPACK_ERR_BASE);
        PUT(0, wb_u8(ops, opcode));
        uint64_t pos[HBCPACK_MAX_OPERANDS]; uint64_t q = loc + 1;
        for (int j = 0; j < d->n; j++) { pos[j] = q; q += d->width[j]; }
        if (q > end) XFAIL(HBCPACK_ERR_BASE);
        for (int j = 0; j < d->n; j++) {
          uint32_t w = d->width[j]; const uint8_t *b = buf + pos[j];
          uint32_t v = w == 1 ? b[0] : w == 2 ? (uint32_t)(b[0] | (b[1] << 8)) : ld32(b);
          if (j == d->cache_ci) {
            uint32_t sw_ = d->width[d->cache_si]; const uint8_t *sb = buf + pos[d->cache_si];
            uint32_t sid = sw_ == 1 ? sb[0] : sw_ == 2 ? (uint32_t)(sb[0] | (sb[1] << 8)) : ld32(sb);
            uint32_t rank; if (!rm_rank(d->cache_write ? &wr : &rr, sid, &rank)) XFAIL(HBCPACK_ERR_ALLOC);
            PUT(0, wb_svarint(cres, (int64_t)v - (int64_t)rank));
          } else if (IS_ID_STREAM(d->stream[j])) PUT(0, wb_u32(&opnd[d->stream[j]], v));
          else PUT(0, wb_bytes(&opnd[d->stream[j]], b, w));
          if (d->sw) { if (d->sw == 1) { if (j == 3) switch_min = v; else if (j == 4) { if (v < switch_min || v - switch_min >= (1u << 28)) XFAIL(HBCPACK_ERR_BASE); table_bytes += 4 * (v - switch_min + 1); } } else if (j == 4) { if (v >= (1u << 28)) XFAIL(HBCPACK_ERR_BASE); table_bytes += 8 * v; } }
        }
        loc = q;
      }
      if (table_bytes) {
        uint64_t aligned = (loc + 3) & ~3ull;
        if (aligned + table_bytes > len) XFAIL(HBCPACK_ERR_BASE);
        for (uint64_t p = loc; p < aligned; p++) if (buf[p]) XFAIL(HBCPACK_ERR_BASE);
        PUT(0, wb_bytes(sw, buf + aligned, table_bytes));
        loc = aligned + table_bytes;
      }
    }
  }
  for (int i = 0; i < nstreams; i++) { B->s[i].data = W[i].p ? W[i].p : (uint8_t *)calloc(1, 1); B->s[i].len = W[i].len; W[i].p = NULL; stream_name(P, i, B->names[i]); }
  B->count = nstreams;
#undef PUT
done:
  for (int i = 0; i < MAX_STREAMS; i++) free(W[i].p);
  free(fh); free(large_at); um_free(&bodies); rm_free(&rr); rm_free(&wr);
  if (status != HBCPACK_OK) free_base(B);
  return status;
}

/* ------------------------------------------------------------------------------------------ */
/* container                                                                                    */

/* Reads the container header: version and, for version 3, the base footer it was made against. */
static hbcpack_status peek_container(const uint8_t *in, size_t in_len, uint32_t *ver, const uint8_t **footer) {
  reader r = { in, in_len, 0 }; const uint8_t *magic; uint32_t count;
  *footer = NULL;
  if (!rd_bytes(&r, 4, &magic) || memcmp(magic, "HBCP", 4) != 0) return HBCPACK_ERR_FORMAT;
  if (!rd_u8(&r, ver) || !rd_u8(&r, &count)) return HBCPACK_ERR_TRUNCATED;
  if (*ver != 2 && *ver != 3) return HBCPACK_ERR_UNSUPPORTED;
  if (*ver == 3 && !rd_bytes(&r, 20, footer)) return HBCPACK_ERR_TRUNCATED;
  return HBCPACK_OK;
}

/* B: the base file's streams (version 3 containers; they are the dictionaries), else NULL. */
static hbcpack_status decode_streams(const uint8_t *in, size_t in_len, const hbcpack_options *opts, const base_streams *B, streams *out, int only_header) {
  reader r = { in, in_len, 0 };
  const uint8_t *magic, *footer; uint32_t ver, count;
  memset(out, 0, sizeof *out);
  if (!rd_bytes(&r, 4, &magic) || memcmp(magic, "HBCP", 4) != 0) return HBCPACK_ERR_FORMAT;
  if (!rd_u8(&r, &ver)) return HBCPACK_ERR_TRUNCATED;
  if (ver != 2 && ver != 3) return HBCPACK_ERR_UNSUPPORTED;
  if (!rd_u8(&r, &count)) return HBCPACK_ERR_TRUNCATED;
  if (count == 0 || count > MAX_STREAMS) return HBCPACK_ERR_UNSUPPORTED;
  if (ver == 3) { if (!rd_bytes(&r, 20, &footer)) return HBCPACK_ERR_TRUNCATED; if (!B) return HBCPACK_ERR_BASE; }
  size_t max_output = (opts && opts->max_output) ? opts->max_output : DEFAULT_MAX_OUTPUT;
  ZSTD_DCtx *dctx = NULL;
  hbcpack_status status = HBCPACK_OK;
  out->count = (int)count;
  for (uint32_t i = 0; i < count; i++) {
    uint32_t backend; uint64_t raw_len, stored_len; const uint8_t *data;
    if (!rd_u8(&r, &backend) || !rd_varint(&r, &raw_len) || !rd_varint(&r, &stored_len)) { status = HBCPACK_ERR_TRUNCATED; break; }
    if (raw_len > max_output || !rd_bytes(&r, (size_t)stored_len, &data)) { status = HBCPACK_ERR_TRUNCATED; break; }
    const uint8_t *dict_data = NULL; size_t dict_size = 0; int have_dict = 0;
    if (backend == 4) {
      const uint8_t *name; if (!rd_bytes(&r, 32, &name)) { status = HBCPACK_ERR_TRUNCATED; break; }
      char nm[33]; memcpy(nm, name, 32); nm[32] = 0;
      if (ver == 3) {
        for (int d = 0; d < B->count; d++) if (strcmp(B->names[d], nm) == 0) { dict_data = B->s[d].data; dict_size = B->s[d].len; have_dict = 1; break; }
        if (!have_dict) { status = HBCPACK_ERR_FORMAT; break; }
      } else {
        if (opts && opts->dicts) for (size_t d = 0; d < opts->ndicts; d++) if (strcmp(opts->dicts[d].name, nm) == 0) { dict_data = opts->dicts[d].data; dict_size = opts->dicts[d].size; have_dict = 1; break; }
        if (!have_dict) { status = HBCPACK_ERR_DICT; break; }
      }
    }
    if (only_header && i > 0) break;
    uint8_t *buf = (uint8_t *)malloc(raw_len ? (size_t)raw_len : 1);
    if (!buf) { status = HBCPACK_ERR_ALLOC; break; }
    int ok = 0;
    switch (backend) {
      case 0: ok = stored_len == raw_len; if (ok) memcpy(buf, data, (size_t)raw_len); break;
      case 1: { size_t n = ZSTD_decompress(buf, (size_t)raw_len, data, (size_t)stored_len); ok = zstd_ok(n) && n == raw_len; break; }
      case 2: { size_t n = (size_t)raw_len; ok = BrotliDecoderDecompress((size_t)stored_len, data, &n, buf) == BROTLI_DECODER_RESULT_SUCCESS && n == raw_len; break; }
      case 4: {
        if (!dctx) dctx = ZSTD_createDCtx();
        if (!dctx) { free(buf); status = HBCPACK_ERR_ALLOC; goto done; }
        size_t n = ZSTD_decompress_usingDict(dctx, buf, (size_t)raw_len, data, (size_t)stored_len, dict_data, dict_size);
        ok = zstd_ok(n) && n == raw_len; break;
      }
      default: free(buf); status = HBCPACK_ERR_UNSUPPORTED; goto done;
    }
    if (!ok) { free(buf); status = HBCPACK_ERR_BACKEND; break; }
    out->s[i].data = buf; out->s[i].len = (size_t)raw_len;
  }
done:
  ZSTD_freeDCtx(dctx);
  if (status != HBCPACK_OK) free_streams(out);
  return status;
}

/* ------------------------------------------------------------------------------------------ */
/* string-id map (delta containers)                                                            */

/* Canonical ids (FORMAT.md): each of the new file's strings takes the id of the first base string
 * with the same content (utf16 flag + bytes), each base id used once; the rest get fresh ids past
 * the base's table in order. from[canonical] = new id, or -1 for unused base ids. */
typedef struct { uint32_t off, len; uint8_t utf16; } strref;

static uint64_t key_hash(const uint8_t *p, size_t n, int utf16) {
  uint64_t h = 1469598103934665603ull ^ (utf16 ? 0x9e3779b97f4a7c15ull : 0);
  for (size_t i = 0; i < n; i++) { h ^= p[i]; h *= 1099511628211ull; }
  return h;
}
static int key_eq(const uint8_t *a, uint32_t alen, int autf16, const uint8_t *b, uint32_t blen, int butf16) {
  return alen == blen && autf16 == butf16 && memcmp(a, b, (size_t)alen * (autf16 ? 2 : 1)) == 0;
}
static hbcpack_status canonical_map(const base_streams *B, const strref *refs, uint32_t new_count, const uint8_t *new_storage, int32_t **from_out, uint32_t *canon_count) {
  hbcpack_status status = HBCPACK_OK;
  uint32_t cap = 64; while (cap < 2 * (B->string_count + 1)) cap *= 2;
  uint32_t *tab = (uint32_t *)calloc(cap, 4); uint8_t *used = (uint8_t *)calloc((size_t)B->string_count + 1, 1);
  int32_t *from = (int32_t *)malloc(((size_t)B->string_count + new_count + 1) * 4);
  if (!tab || !used || !from) { status = HBCPACK_ERR_ALLOC; goto done; }
  for (uint32_t b = 0; b < B->string_count; b++) {
    const uint8_t *p = B->storage + B->str_off[b]; uint32_t len = B->str_len[b]; int u = B->str_utf16[b];
    uint32_t h = (uint32_t)key_hash(p, (size_t)len * (u ? 2 : 1), u) & (cap - 1); int dup = 0;
    while (tab[h]) { uint32_t o = tab[h] - 1; if (key_eq(B->storage + B->str_off[o], B->str_len[o], B->str_utf16[o], p, len, u)) { dup = 1; break; } h = (h + 1) & (cap - 1); }
    if (!dup) tab[h] = b + 1;
  }
  for (uint32_t c = 0; c < B->string_count; c++) from[c] = -1;
  uint32_t fresh = B->string_count;
  for (uint32_t i = 0; i < new_count; i++) {
    const uint8_t *p = new_storage + refs[i].off; uint32_t len = refs[i].len; int u = refs[i].utf16;
    uint32_t h = (uint32_t)key_hash(p, (size_t)len * (u ? 2 : 1), u) & (cap - 1); int32_t b = -1;
    while (tab[h]) { uint32_t o = tab[h] - 1; if (key_eq(B->storage + B->str_off[o], B->str_len[o], B->str_utf16[o], p, len, u)) { b = (int32_t)o; break; } h = (h + 1) & (cap - 1); }
    if (b >= 0 && !used[b]) { used[b] = 1; from[b] = (int32_t)i; } else from[fresh++] = (int32_t)i;
  }
  *from_out = from; from = NULL; *canon_count = fresh;
done:
  free(tab); free(used); free(from);
  return status;
}

/* ------------------------------------------------------------------------------------------ */
/* rebuild                                                                                      */



#define FAIL(code) do { status = (code); goto done; } while (0)
#define NEED_OUT(n) do { if ((uint64_t)loc + (n) > h.fileLength) FAIL(HBCPACK_ERR_FORMAT); } while (0)
/* canonical string id -> the new file's id */
#define UNMAP(c, v) do { uint32_t _c = (c); if (_c >= canon_count || from[_c] < 0) FAIL(HBCPACK_ERR_FORMAT); (v) = (uint32_t)from[_c]; } while (0)

/* B: the base file's streams and strings for a delta container, else NULL. */
static hbcpack_status rebuild(streams *st, const base_streams *B, uint8_t **out_buf, size_t *out_len) {
  hbcpack_status status = HBCPACK_OK;
  hbc_header h; section t[T_COUNT]; uint32_t tables_end;
  uint8_t *out = NULL; fheader *fh = NULL; uint32_t *body_off = NULL; uint32_t *reuse = NULL;
  strref *refs = NULL; int32_t *from = NULL; uint32_t canon_count = 0;
  rankmap rr = {0}, wr = {0};
  stream *s = st->s;
  if (!parse_header(&s[S_HEADER], &h)) return HBCPACK_ERR_UNSUPPORTED;
  const profile *P = h.P;
  if (st->count != S_FIXED_COUNT + P->ncols + TAIL_COUNT) return HBCPACK_ERR_FORMAT;
  const stream *col = s + S_FIXED_COUNT;            /* header columns */
  const stream *tail = col + P->ncols;              /* fhReuse ... cacheRes */
  if (!layout(&h, t, &tables_end)) return HBCPACK_ERR_FORMAT;
  if (h.debugInfoOffset < tables_end || h.debugInfoOffset + 20 > h.fileLength) return HBCPACK_ERR_FORMAT;
  if (s[S_DEBUG].len != h.fileLength - 20 - h.debugInfoOffset) return HBCPACK_ERR_FORMAT;
  out = (uint8_t *)calloc(h.fileLength, 1);
  if (!out) return HBCPACK_ERR_ALLOC;
  memcpy(out, s[S_HEADER].data, HEADER_SIZE);
  PROF_START();

  /* --- tables --------------------------------------------------------------------------- */
  {
    reader pad = { s[S_PADDING].data, s[S_PADDING].len, 0 };
    reader misc = { s[S_MISC].data, s[S_MISC].len, 0 };
    const stream *verbatim[T_COUNT] = { NULL, &s[S_KINDS], NULL, NULL, NULL, &s[S_STORAGE], &s[S_ARRAYBUF], &s[S_OBJKEYBUF], &s[S_THIRD], NULL, NULL, NULL, NULL, NULL, NULL };
    uint32_t o = HEADER_SIZE;
    for (int i = 0; i < T_COUNT; i++) {
      const uint8_t *gap; if (!rd_bytes(&pad, t[i].start - o, &gap)) FAIL(HBCPACK_ERR_FORMAT);
      memcpy(out + o, gap, t[i].start - o);
      if (verbatim[i]) { if (verbatim[i]->len != t[i].size) FAIL(HBCPACK_ERR_FORMAT); memcpy(out + t[i].start, verbatim[i]->data, t[i].size); }
      else if (i >= T_BIGINT) { const uint8_t *m; if (!rd_bytes(&misc, t[i].size, &m)) FAIL(HBCPACK_ERR_FORMAT); memcpy(out + t[i].start, m, t[i].size); }
      o = t[i].start + t[i].size;
    }
    const uint8_t *gap; if (!rd_bytes(&pad, tables_end - o, &gap)) FAIL(HBCPACK_ERR_FORMAT);
    memcpy(out + o, gap, tables_end - o);
    if (pad.pos != pad.len || misc.pos != misc.len) FAIL(HBCPACK_ERR_FORMAT);
  }

  /* --- string table, overflow table, identifier hashes --------------------------------- */
  {
    if (s[S_STRFLAGS].len != h.stringCount) FAIL(HBCPACK_ERR_FORMAT);
    reader lens = { s[S_STRLENS].data, s[S_STRLENS].len, 0 }, deltas = { s[S_STRDELTAS].data, s[S_STRDELTAS].len, 0 };
    uint8_t *table = out + t[T_STRTABLE].start, *overflow = out + t[T_OVERFLOW].start, *hashes = out + t[T_HASHES].start;
    const uint8_t *storage = s[S_STORAGE].data;
    uint32_t si = 0, ii = 0, oi = 0;
    if (B) { refs = (strref *)malloc(((size_t)h.stringCount + 1) * sizeof(strref)); if (!refs) FAIL(HBCPACK_ERR_ALLOC); }
    for (uint32_t k = 0; k < h.stringKindCount; k++) {
      uint32_t kind = ld32(s[S_KINDS].data + 4 * k);
      int identifier = (kind >> 31) & 1; uint32_t run = kind & 0x7fffffff;
      uint64_t prev = 0;
      for (uint32_t j = 0; j < run; j++, si++) {
        if (si >= h.stringCount) FAIL(HBCPACK_ERR_FORMAT);
        uint64_t len; int64_t delta;
        if (!rd_varint(&lens, &len) || !rd_svarint(&deltas, &delta)) FAIL(HBCPACK_ERR_TRUNCATED);
        int64_t off64 = (int64_t)prev + delta;
        if (off64 < 0 || off64 > 0xffffffffll || len > 0xffffffffull) FAIL(HBCPACK_ERR_FORMAT);
        uint32_t offset = (uint32_t)off64, length = (uint32_t)len; int utf16 = s[S_STRFLAGS].data[si] == 1;
        uint64_t bytes = (uint64_t)length * (utf16 ? 2 : 1);
        if (offset + bytes > h.stringStorageSize) FAIL(HBCPACK_ERR_FORMAT);
        prev = offset + bytes;
        if (B) { refs[si].off = offset; refs[si].len = length; refs[si].utf16 = (uint8_t)utf16; }
        if (length >= 255) {
          if (oi >= h.overflowStringCount || offset >= (1u << 23)) FAIL(HBCPACK_ERR_FORMAT);
          st32(table + 4 * si, (255u << 24) | (oi << 1) | (uint32_t)utf16);
          st32(overflow + 8 * oi, offset); st32(overflow + 8 * oi + 4, length); oi++;
        } else {
          if (offset >= (1u << 23)) FAIL(HBCPACK_ERR_FORMAT);
          st32(table + 4 * si, (length << 24) | (offset << 1) | (uint32_t)utf16);
        }
        if (identifier) {
          if (ii >= h.identifierCount) FAIL(HBCPACK_ERR_FORMAT);
          uint32_t hsh = 0;
          if (utf16) for (uint32_t c = 0; c < length; c++) { uint32_t u = storage[offset + 2 * c] | ((uint32_t)storage[offset + 2 * c + 1] << 8); hsh += u; hsh += hsh << 10; hsh ^= hsh >> 6; }
          else for (uint32_t c = 0; c < length; c++) { hsh += storage[offset + c]; hsh += hsh << 10; hsh ^= hsh >> 6; }
          st32(hashes + 4 * ii, hsh); ii++;
        }
      }
    }
    if (si != h.stringCount || ii != h.identifierCount || oi != h.overflowStringCount) FAIL(HBCPACK_ERR_FORMAT);
    if (B) { status = canonical_map(B, refs, h.stringCount, storage, &from, &canon_count); if (status != HBCPACK_OK) goto done; }
  }
  PROF_MARK("strings");

  /* --- function header columns --------------------------------------------------------- */
  const uint32_t n = h.functionCount;
  fh = (fheader *)calloc(n ? n : 1, sizeof(fheader)); body_off = (uint32_t *)malloc(((size_t)n + 1) * 4); reuse = (uint32_t *)malloc(((size_t)n + 1) * 4);
  if (!fh || !body_off || !reuse) FAIL(HBCPACK_ERR_ALLOC);
  {
    reader cr[16];
    for (int c = 0; c < P->ncols; c++) {
      if (!P->cols[c].varint && col[c].len != n) FAIL(HBCPACK_ERR_FORMAT);
      cr[c].p = col[c].data; cr[c].len = col[c].len; cr[c].pos = 0;
    }
    reader rreuse = { tail[TAIL_REUSE].data, tail[TAIL_REUSE].len, 0 };
    for (uint32_t i = 0; i < n; i++) {
      fheader *f = &fh[i];
      for (int c = 0; c < P->ncols; c++) {
        uint32_t v;
        if (P->cols[c].varint) { if (!rd_varint32(&cr[c], &v)) FAIL(HBCPACK_ERR_TRUNCATED); } else v = col[c].data[i];
        if (B && P->cols[c].field == F_NAME) UNMAP(v, v);
        set_field(f, P->cols[c].field, v);
      }
      if (f->flags & 0x20) FAIL(HBCPACK_ERR_FORMAT);
      uint32_t v; if (!rd_varint32(&rreuse, &v) || v > i) FAIL(HBCPACK_ERR_FORMAT); reuse[i] = v;
    }
  }

  /* --- bodies ---------------------------------------------------------------------------- */
  uint32_t loc = tables_end;
  {
    reader ops = { tail[TAIL_OPCODES].data, tail[TAIL_OPCODES].len, 0 };
    reader opnd[HBCPACK_NUM_OPERAND_STREAMS];
    for (int k = 0; k < HBCPACK_NUM_OPERAND_STREAMS; k++) { opnd[k].p = tail[TAIL_OPERANDS + k].data; opnd[k].len = tail[TAIL_OPERANDS + k].len; opnd[k].pos = 0; }
    reader sw = { tail[TAIL_SWITCH].data, tail[TAIL_SWITCH].len, 0 }, cres = { tail[TAIL_CACHERES].data, tail[TAIL_CACHERES].len, 0 };
    if (!rm_init(&rr, 1024) || !rm_init(&wr, 1024)) FAIL(HBCPACK_ERR_ALLOC);
    for (uint32_t i = 0; i < n; i++) {
      fheader *f = &fh[i];
      if (reuse[i]) {
        uint32_t src = i - reuse[i];
        if (fh[src].size != f->size) FAIL(HBCPACK_ERR_FORMAT);
        f->offset = body_off[src]; body_off[i] = f->offset; continue;
      }
      f->offset = loc; body_off[i] = loc;
      uint64_t end64 = (uint64_t)loc + f->size; if (end64 > h.fileLength) FAIL(HBCPACK_ERR_FORMAT);
      uint32_t end = (uint32_t)end64, table_bytes = 0, switch_min = 0;
      rm_reset(&rr); rm_reset(&wr);
      while (loc < end) {
        uint32_t opcode; if (!rd_u8(&ops, &opcode)) FAIL(HBCPACK_ERR_TRUNCATED);
        const hbcpack_opcode *d = &P->ops[opcode];
        if (!d->name) FAIL(HBCPACK_ERR_FORMAT);
        out[loc++] = (uint8_t)opcode;
        uint32_t cache_loc = 0, sid_loc = 0; int have_cache = 0;
        for (int j = 0; j < d->n; j++) {
          uint32_t w = d->width[j];
          NEED_OUT(w);
          if (j == d->cache_ci) { cache_loc = loc; have_cache = 1; loc += 1; continue; }
          if (j == d->cache_si) sid_loc = loc;
          const uint8_t *b;
          if (B && IS_ID_STREAM(d->stream[j])) {
            /* delta: u32 canonical id, written back at the operand's width */
            uint32_t v; if (!rd_bytes(&opnd[d->stream[j]], 4, &b)) FAIL(HBCPACK_ERR_TRUNCATED);
            UNMAP(ld32(b), v);
            if (w == 1) { if (v > 0xff) FAIL(HBCPACK_ERR_FORMAT); out[loc] = (uint8_t)v; }
            else if (w == 2) { if (v > 0xffff) FAIL(HBCPACK_ERR_FORMAT); out[loc] = (uint8_t)v; out[loc + 1] = (uint8_t)(v >> 8); }
            else st32(out + loc, v);
            loc += w; continue;
          }
          if (!rd_bytes(&opnd[d->stream[j]], w, &b)) FAIL(HBCPACK_ERR_TRUNCATED);
          memcpy(out + loc, b, w);
          if (d->sw) {
            uint32_t v = ld32(b);
            if (d->sw == 1) { if (j == 3) switch_min = v; else if (j == 4) { if (v < switch_min || v - switch_min >= (1u << 28)) FAIL(HBCPACK_ERR_FORMAT); table_bytes += 4 * (v - switch_min + 1); } }
            else if (j == 4) { if (v >= (1u << 28)) FAIL(HBCPACK_ERR_FORMAT); table_bytes += 8 * v; }
          }
          loc += w;
        }
        if (have_cache) {
          uint32_t sw_ = d->width[d->cache_si], sid = sw_ == 1 ? out[sid_loc] : sw_ == 2 ? (uint32_t)(out[sid_loc] | (out[sid_loc + 1] << 8)) : ld32(out + sid_loc);
          uint32_t rank; int64_t res;
          if (!rm_rank(d->cache_write ? &wr : &rr, sid, &rank)) FAIL(HBCPACK_ERR_ALLOC);
          if (!rd_svarint(&cres, &res)) FAIL(HBCPACK_ERR_TRUNCATED);
          out[cache_loc] = (uint8_t)((uint32_t)rank + (uint32_t)res);
        }
      }
      if (loc != end) FAIL(HBCPACK_ERR_FORMAT);
      if (table_bytes) {
        uint32_t aligned = align4(loc);
        if ((uint64_t)aligned + table_bytes > h.fileLength) FAIL(HBCPACK_ERR_FORMAT);
        const uint8_t *tb; if (!rd_bytes(&sw, table_bytes, &tb)) FAIL(HBCPACK_ERR_TRUNCATED);
        memcpy(out + aligned, tb, table_bytes);
        loc = aligned + table_bytes;
      }
    }
  }
  PROF_MARK("bodies");

  /* --- info section and small headers ---------------------------------------------------- */
  {
    reader exc_count = { tail[TAIL_EXCCOUNT].data, tail[TAIL_EXCCOUNT].len, 0 }, exc_start = { tail[TAIL_EXCSTART].data, tail[TAIL_EXCSTART].len, 0 },
           exc_end = { tail[TAIL_EXCEND].data, tail[TAIL_EXCEND].len, 0 }, exc_target = { tail[TAIL_EXCTARGET].data, tail[TAIL_EXCTARGET].len, 0 },
           dbg = { tail[TAIL_DEBUGOFF].data, tail[TAIL_DEBUGOFF].len, 0 };
    loc = align4(loc);
    uint8_t *ht = out + t[T_FUNCHEADERS].start;
    for (uint32_t i = 0; i < n; i++) {
      fheader *f = &fh[i]; uint8_t *sh = ht + P->small_fh * i;
      int has_exc = (f->flags >> 3) & 1, has_dbg = (f->flags >> 4) & 1;
      if (!P->info_always) {
        if (!has_exc && !has_dbg && fits_small(P, f)) { encode_small(P, f, sh); continue; }
        loc = align4(loc);
        NEED_OUT(P->large_fh);
        encode_pointer_small(P, f, loc, sh);
        encode_large(P, f, out + loc); loc += P->large_fh;
      } else {
        loc = align4(loc);
        f->infoOffset = loc;
        if (fits_small(P, f)) encode_small(P, f, sh);
        else { NEED_OUT(P->large_fh); encode_pointer_small(P, f, loc, sh); encode_large(P, f, out + loc); loc += P->large_fh; }
      }
      if (has_exc) {
        uint64_t count; if (!rd_varint(&exc_count, &count) || count > (1u << 24)) FAIL(HBCPACK_ERR_FORMAT);
        NEED_OUT(4 + 12 * count);
        st32(out + loc, (uint32_t)count); loc += 4;
        int64_t prev_start = 0;
        for (uint64_t e = 0; e < count; e++) {
          int64_t ds, de, dt;
          if (!rd_svarint(&exc_start, &ds) || !rd_svarint(&exc_end, &de) || !rd_svarint(&exc_target, &dt)) FAIL(HBCPACK_ERR_TRUNCATED);
          int64_t a = prev_start + ds, b = a + de, c = b + dt;
          if (a < 0 || b < 0 || c < 0 || a > 0xffffffffll || b > 0xffffffffll || c > 0xffffffffll) FAIL(HBCPACK_ERR_FORMAT);
          st32(out + loc, (uint32_t)a); st32(out + loc + 4, (uint32_t)b); st32(out + loc + 8, (uint32_t)c); loc += 12; prev_start = a;
        }
      }
      if (has_dbg) { const uint8_t *d; if (!rd_bytes(&dbg, P->debug_offsets, &d)) FAIL(HBCPACK_ERR_TRUNCATED); NEED_OUT(P->debug_offsets); memcpy(out + loc, d, P->debug_offsets); loc += P->debug_offsets; }
    }
    if (align4(loc) != h.debugInfoOffset && loc != h.debugInfoOffset) FAIL(HBCPACK_ERR_FORMAT);
  }
  PROF_MARK("info");

  /* --- debug info and footer ------------------------------------------------------------- */
  memcpy(out + h.debugInfoOffset, s[S_DEBUG].data, s[S_DEBUG].len);
  { sha1_ctx c; sha1_init(&c); sha1_update(&c, out, h.fileLength - 20); sha1_final(&c, out + h.fileLength - 20); }
  PROF_MARK("sha1");
  *out_buf = out; *out_len = h.fileLength; out = NULL;

done:
  free(out); free(fh); free(body_off); free(reuse); free(refs); free(from); rm_free(&rr); rm_free(&wr);
  return status;
}

/* ------------------------------------------------------------------------------------------ */
/* public API                                                                                   */

/* Version 3 containers need the installed file: checks it is the one the container was made against. */
static hbcpack_status check_base(const hbcpack_options *opts, const uint8_t *footer) {
  if (!opts || !opts->base || opts->base_len < HEADER_SIZE + 20) return HBCPACK_ERR_BASE;
  if (memcmp(opts->base + opts->base_len - 20, footer, 20) != 0) return HBCPACK_ERR_BASE;
  return HBCPACK_OK;
}

hbcpack_status hbcpack_unpack(const uint8_t *in, size_t in_len, const hbcpack_options *opts, uint8_t **out, size_t *out_len) {
  streams st; base_streams B; const base_streams *Bp = NULL;
  uint32_t ver; const uint8_t *footer;
  *out = NULL; *out_len = 0;
#ifdef HBCPACK_PROFILE
  double t0 = prof_now();
#endif
  hbcpack_status status = peek_container(in, in_len, &ver, &footer);
  if (status != HBCPACK_OK) return status;
  if (ver == 3) {
    status = check_base(opts, footer);
    if (status == HBCPACK_OK) status = extract_base(opts->base, opts->base_len, &B);
    if (status != HBCPACK_OK) return status;
    Bp = &B;
  }
#ifdef HBCPACK_PROFILE
  fprintf(stderr, "  %-10s %7.2f ms\n", "base", prof_now() - t0); t0 = prof_now();
#endif
  status = decode_streams(in, in_len, opts, Bp, &st, 0);
#ifdef HBCPACK_PROFILE
  fprintf(stderr, "  %-10s %7.2f ms\n", "streams", prof_now() - t0);
#endif
  if (status == HBCPACK_OK) {
    hbc_header h;
    if (!parse_header(&st.s[S_HEADER], &h)) status = HBCPACK_ERR_UNSUPPORTED;
    else if (h.fileLength > ((opts && opts->max_output) ? opts->max_output : DEFAULT_MAX_OUTPUT)) status = HBCPACK_ERR_LIMIT;
    else status = rebuild(&st, Bp, out, out_len);
    free_streams(&st);
  }
  if (Bp) free_base(&B);
  return status;
}

hbcpack_status hbcpack_unpacked_size(const uint8_t *in, size_t in_len, const hbcpack_options *opts, size_t *size) {
  streams st; base_streams B; const base_streams *Bp = NULL;
  uint32_t ver; const uint8_t *footer;
  hbcpack_status status = peek_container(in, in_len, &ver, &footer);
  if (status != HBCPACK_OK) return status;
  if (ver == 3) {
    /* Only the header stream is decoded; its dictionary is the base's header. */
    status = check_base(opts, footer);
    if (status != HBCPACK_OK) return status;
    memset(&B, 0, sizeof B);
    B.s[S_HEADER].data = (uint8_t *)opts->base; B.s[S_HEADER].len = HEADER_SIZE; snprintf(B.names[S_HEADER], sizeof B.names[S_HEADER], "%s", FIXED_NAMES[S_HEADER]); B.count = 1;
    Bp = &B;
  }
  status = decode_streams(in, in_len, opts, Bp, &st, 1);
  if (status == HBCPACK_OK) { hbc_header h; if (parse_header(&st.s[S_HEADER], &h)) *size = h.fileLength; else status = HBCPACK_ERR_UNSUPPORTED; free_streams(&st); }
  return status;
}

void hbcpack_free(uint8_t *p) { free(p); }

const char *hbcpack_strerror(hbcpack_status status) {
  switch (status) {
    case HBCPACK_OK: return "ok";
    case HBCPACK_ERR_FORMAT: return "malformed hbc-pack data";
    case HBCPACK_ERR_UNSUPPORTED: return "unsupported container, backend or bytecode version";
    case HBCPACK_ERR_TRUNCATED: return "truncated data";
    case HBCPACK_ERR_BACKEND: return "zstd or brotli reported corrupt data";
    case HBCPACK_ERR_DICT: return "a required dictionary was not supplied";
    case HBCPACK_ERR_ALLOC: return "out of memory";
    case HBCPACK_ERR_LIMIT: return "output exceeds the size limit";
    case HBCPACK_ERR_BASE: return "delta container: the installed base file is missing or is not the one it was made against";
  }
  return "unknown error";
}
