/*
 * Mutation fuzzer for the hbc-pack decoder, self-contained (Apple clang ships no libFuzzer).
 * Build with ASan + UBSan (native/fuzz/build.sh) and run:
 *
 *   native/fuzz/hbcpack-fuzz <seedDir> <seconds> [seed]
 *
 * Seeds: every .hbcp file in <seedDir>; a seed with a matching <name>.base file is decoded as a delta
 * container against that base. Each iteration picks a seed, applies 1–8 random mutations (bit
 * flips, byte sets, truncation, chunk insert/delete/duplicate, splice from another seed,
 * interesting-integer writes) and calls hbcpack_unpack and hbcpack_unpacked_size. Any crash,
 * sanitizer report, or an OK result whose length disagrees with hbcpack_unpacked_size is a
 * finding; the offending input is written to <seedDir>/../crash-<n>.bin.
 */
#include "../hbcpack.h"

#include <dirent.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct { uint8_t *p; size_t n; uint8_t *base; size_t base_n; char name[256]; } seed_t;

static uint64_t rng_state = 0x9e3779b97f4a7c15ull;
static uint64_t rnd(void) { uint64_t x = rng_state; x ^= x << 13; x ^= x >> 7; x ^= x << 17; return rng_state = x; }
static size_t rnd_below(size_t n) { return n ? (size_t)(rnd() % n) : 0; }

static uint8_t *read_file(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb"); if (!f) return NULL;
  fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
  uint8_t *buf = (uint8_t *)malloc(n > 0 ? (size_t)n : 1);
  if (buf && fread(buf, 1, (size_t)n, f) != (size_t)n) { free(buf); buf = NULL; }
  fclose(f); *len = (size_t)n; return buf;
}

static const uint32_t INTERESTING[] = { 0, 1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 48, 63, 64, 100, 127, 128, 255, 256, 1023, 1024, 4095, 65535, 65536,
                                        0x7fffffff, 0x80000000u, 0xfffffffeu, 0xffffffffu, 0x1ffffff, 0x1000000, 0x10000000 };

/* One mutation of buf (capacity cap, length *n); other = another seed for splicing. */
static void mutate(uint8_t *buf, size_t *n, size_t cap, const seed_t *other) {
  size_t len = *n;
  switch (rnd() % 10) {
    case 0: if (len) buf[rnd_below(len)] ^= (uint8_t)(1u << (rnd() & 7)); break;                       /* bit flip */
    case 1: if (len) buf[rnd_below(len)] = (uint8_t)rnd(); break;                                      /* random byte */
    case 2: if (len) { size_t at = rnd_below(len); uint32_t v = INTERESTING[rnd() % (sizeof INTERESTING / sizeof *INTERESTING)];   /* interesting int */
              size_t w = 1u << (rnd() % 3); for (size_t i = 0; i < w && at + i < len; i++) buf[at + i] = (uint8_t)(v >> (8 * i)); } break;
    case 3: if (len > 1) *n = rnd_below(len); break;                                                   /* truncate */
    case 4: if (len) { size_t at = rnd_below(len), k = 1 + rnd_below(len - at < 64 ? len - at : 64); memmove(buf + at, buf + at + k, len - at - k); *n = len - k; } break; /* delete chunk */
    case 5: if (len && len < cap) { size_t at = rnd_below(len), k = 1 + rnd_below(32); if (len + k > cap) k = cap - len;   /* insert random */
              memmove(buf + at + k, buf + at, len - at); for (size_t i = 0; i < k; i++) buf[at + i] = (uint8_t)rnd(); *n = len + k; } break;
    case 6: if (len > 1 && len < cap) { size_t from = rnd_below(len - 1), k = 1 + rnd_below(len - from < 64 ? len - from : 64), at = rnd_below(len);   /* duplicate chunk */
              if (len + k > cap) k = cap - len; memmove(buf + at + k, buf + at, len - at); memmove(buf + at, buf + from + (from >= at ? k : 0), k); *n = len + k; } break;
    case 7: if (other && other->n && len) { size_t from = rnd_below(other->n), k = 1 + rnd_below(other->n - from < 128 ? other->n - from : 128), at = rnd_below(len);   /* splice */
              if (at + k > len) k = len - at; memcpy(buf + at, other->p + from, k); } break;
    case 8: if (len) { size_t at = rnd_below(len), k = 1 + rnd_below(len - at < 16 ? len - at : 16); memset(buf + at, (int)(rnd() & 1 ? 0xff : 0), k); } break; /* zero / ff run */
    default: if (len) { size_t at = rnd_below(len); buf[at] = (uint8_t)(buf[at] + (rnd() & 1 ? 1 : -1)); } break;  /* +-1 */
  }
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: hbcpack-fuzz <seedDir> <seconds> [seed]\n"); return 2; }
  const char *dir = argv[1]; double seconds = atof(argv[2]);
  if (argc > 3) rng_state ^= (uint64_t)strtoull(argv[3], NULL, 10) * 0x100000001b3ull; else rng_state ^= (uint64_t)time(NULL);
  seed_t seeds[256]; int nseeds = 0;
  DIR *d = opendir(dir); if (!d) { fprintf(stderr, "cannot open %s\n", dir); return 1; }
  struct dirent *e;
  while ((e = readdir(d)) && nseeds < 256) {
    size_t l = strlen(e->d_name); if (l < 6 || strcmp(e->d_name + l - 5, ".hbcp") != 0) continue;
    char path[4096]; snprintf(path, sizeof path, "%s/%s", dir, e->d_name);
    seed_t *s = &seeds[nseeds]; memset(s, 0, sizeof *s);
    s->p = read_file(path, &s->n); if (!s->p) continue;
    snprintf(s->name, sizeof s->name, "%.*s", (int)(l - 5), e->d_name);
    snprintf(path, sizeof path, "%s/%.*s.base", dir, (int)(l - 5), e->d_name);
    s->base = read_file(path, &s->base_n);
    nseeds++;
  }
  closedir(d);
  if (!nseeds) { fprintf(stderr, "no seeds in %s\n", dir); return 1; }
  size_t cap = 0; for (int i = 0; i < nseeds; i++) if (seeds[i].n > cap) cap = seeds[i].n;
  cap = cap * 2 + 4096;
  uint8_t *buf = (uint8_t *)malloc(cap);
  fprintf(stderr, "%d seeds, max %zu bytes, %.0f s\n", nseeds, cap, seconds);

  /* Every seed must decode as is (a broken seed would waste the run). */
  for (int i = 0; i < nseeds; i++) {
    hbcpack_options o = { NULL, 0, 0, seeds[i].base, seeds[i].base_n }; uint8_t *out; size_t out_len;
    hbcpack_status st = hbcpack_unpack(seeds[i].p, seeds[i].n, &o, &out, &out_len);
    if (st != HBCPACK_OK) { fprintf(stderr, "seed %s does not decode: %s\n", seeds[i].name, hbcpack_strerror(st)); return 1; }
    hbcpack_free(out);
  }

  time_t start = time(NULL); unsigned long iters = 0, ok = 0, crashes = 0; unsigned long by_status[16] = {0};
  while (difftime(time(NULL), start) < seconds) {
    for (int batch = 0; batch < 1000; batch++, iters++) {
      const seed_t *s = &seeds[rnd_below((size_t)nseeds)], *other = &seeds[rnd_below((size_t)nseeds)];
      memcpy(buf, s->p, s->n); size_t n = s->n;
      int muts = 1 + (int)(rnd() % 8);
      for (int m = 0; m < muts; m++) mutate(buf, &n, cap, other);
      /* Sometimes drop the base (a delta seed without its base) or give the wrong one. */
      hbcpack_options o = { NULL, 0, (rnd() % 4 == 0) ? 1u << 20 : 0, s->base, s->base_n };
      if (s->base && rnd() % 8 == 0) { o.base = other->base ? other->base : other->p; o.base_len = other->base ? other->base_n : other->n; }
      if (rnd() % 16 == 0) { o.base = NULL; o.base_len = 0; }
      uint8_t *out = NULL; size_t out_len = 0, size = 0;
      hbcpack_status st = hbcpack_unpack(buf, n, &o, &out, &out_len);
      hbcpack_status st2 = hbcpack_unpacked_size(buf, n, &o, &size);
      by_status[st & 15]++;
      int bad = 0;
      if (st == HBCPACK_OK) { ok++; if (st2 != HBCPACK_OK || size != out_len) bad = 1; if (!out) bad = 1; }
      if (st == HBCPACK_OK && out) { volatile uint8_t sink = 0; for (size_t i = 0; i < out_len; i += 4096) sink ^= out[i]; (void)sink; }
      hbcpack_free(out);
      if (bad) {
        char path[4096]; snprintf(path, sizeof path, "%s/../crash-%lu.bin", dir, crashes++);
        FILE *f = fopen(path, "wb"); if (f) { fwrite(buf, 1, n, f); fclose(f); }
        fprintf(stderr, "FINDING: unpack=%s size=%s (%zu vs %zu) -> %s\n", hbcpack_strerror(st), hbcpack_strerror(st2), size, out_len, path);
      }
    }
  }
  fprintf(stderr, "%lu iterations, %lu decoded ok, %lu findings\n", iters, ok, crashes);
  fprintf(stderr, "by status:"); for (int i = 0; i < 9; i++) fprintf(stderr, " %s=%lu", i == 0 ? "ok" : hbcpack_strerror((hbcpack_status)i), by_status[i]); fprintf(stderr, "\n");
  for (int i = 0; i < nseeds; i++) { free(seeds[i].p); free(seeds[i].base); }
  free(buf);
  return crashes ? 1 : 0;
}
