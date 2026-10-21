/*
 * hbc-pack native decoder: rebuilds a Hermes bytecode file (HBC version 98) from an HBCP
 * container written by the reference encoder (src/codec-v3.mjs). See ../FORMAT.md.
 *
 * Dependencies: libzstd (ZSTD_decompress, ZSTD_decompress_usingDict) and libbrotlidec.
 * Thread-safe (no global state). The decoder validates every read and write; malformed input
 * yields an error, never undefined behaviour.
 */
#ifndef HBCPACK_H
#define HBCPACK_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define HBCPACK_VERSION "0.1.0"

/* Exported from shared libraries even when built with -fvisibility=hidden. */
#if defined(_WIN32)
#define HBCPACK_API __declspec(dllexport)
#elif defined(__GNUC__)
#define HBCPACK_API __attribute__((visibility("default")))
#else
#define HBCPACK_API
#endif

typedef enum {
  HBCPACK_OK = 0,
  HBCPACK_ERR_FORMAT = 1,      /* not an HBCP container, or inconsistent contents */
  HBCPACK_ERR_UNSUPPORTED = 2, /* container version, backend or HBC version not supported */
  HBCPACK_ERR_TRUNCATED = 3,   /* input or a stream ends early */
  HBCPACK_ERR_BACKEND = 4,     /* zstd or brotli reported corrupt data */
  HBCPACK_ERR_DICT = 5,        /* a stream needs a dictionary that was not supplied */
  HBCPACK_ERR_ALLOC = 6,       /* out of memory */
  HBCPACK_ERR_LIMIT = 7        /* output larger than max_output */
} hbcpack_status;

/* A zstd dictionary for one stream, by stream name (FORMAT.md). */
typedef struct {
  const char *name;
  const uint8_t *data;
  size_t size;
} hbcpack_dict;

typedef struct {
  const hbcpack_dict *dicts; /* may be NULL */
  size_t ndicts;
  size_t max_output;         /* 0 = default (256 MiB) */
} hbcpack_options;

/*
 * Decodes `in` into a newly allocated buffer (*out, *out_len). Free with hbcpack_free().
 * `opts` may be NULL.
 */
HBCPACK_API hbcpack_status hbcpack_unpack(const uint8_t *in, size_t in_len, const hbcpack_options *opts,
                              uint8_t **out, size_t *out_len);

/* Size of the decoded file, from the container's header stream, without decoding the rest. */
HBCPACK_API hbcpack_status hbcpack_unpacked_size(const uint8_t *in, size_t in_len, const hbcpack_options *opts, size_t *size);

HBCPACK_API void hbcpack_free(uint8_t *p);
HBCPACK_API const char *hbcpack_strerror(hbcpack_status status);

#ifdef __cplusplus
}
#endif
#endif
