/*
 * hbcpack CLI: decode an .hbcp file, optionally with a dictionary directory or (delta containers)
 * the installed base file, optionally timing it.
 *
 *   hbcpack unpack <in.hbcp> <out.hbc> [--dicts DIR] [--base old.hbc] [--bench N]
 *   hbcpack size <in.hbcp> [--base old.hbc]        prints the decoded size from the header
 */
#include "hbcpack.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static uint8_t *read_file(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb"); if (!f) return NULL;
  fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
  uint8_t *buf = (uint8_t *)malloc(n > 0 ? (size_t)n : 1);
  if (buf && fread(buf, 1, (size_t)n, f) != (size_t)n) { free(buf); buf = NULL; }
  fclose(f); *len = (size_t)n; return buf;
}

static double now_ms(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return (double)ts.tv_sec * 1e3 + (double)ts.tv_nsec / 1e6; }

int main(int argc, char **argv) {
  int size_only = argc >= 3 && strcmp(argv[1], "size") == 0;
  if (!size_only && (argc < 4 || strcmp(argv[1], "unpack") != 0)) { fprintf(stderr, "usage: hbcpack unpack <in.hbcp> <out.hbc> [--dicts DIR] [--base old.hbc] [--bench N]\n       hbcpack size <in.hbcp> [--base old.hbc]\n"); return 2; }
  const char *dict_dir = NULL, *base_path = NULL; int bench = 0;
  for (int i = size_only ? 3 : 4; i < argc; i++) {
    if (strcmp(argv[i], "--dicts") == 0 && i + 1 < argc) dict_dir = argv[++i];
    else if (strcmp(argv[i], "--base") == 0 && i + 1 < argc) base_path = argv[++i];
    else if (strcmp(argv[i], "--bench") == 0 && i + 1 < argc) bench = atoi(argv[++i]);
  }
  size_t in_len; uint8_t *in = read_file(argv[2], &in_len);
  if (!in) { fprintf(stderr, "cannot read %s\n", argv[2]); return 1; }
  size_t base_len = 0; uint8_t *base = NULL;
  if (base_path) { base = read_file(base_path, &base_len); if (!base) { fprintf(stderr, "cannot read %s\n", base_path); return 1; } }

  hbcpack_dict dicts[64]; size_t ndicts = 0; char names[64][33]; uint8_t *dict_bufs[64];
  if (dict_dir) {
    DIR *d = opendir(dict_dir);
    if (!d) { fprintf(stderr, "cannot open %s\n", dict_dir); return 1; }
    struct dirent *e;
    while ((e = readdir(d)) && ndicts < 64) {
      size_t l = strlen(e->d_name);
      if (l < 7 || strcmp(e->d_name + l - 6, ".zdict") != 0 || l - 6 > 32) continue;
      char path[4096]; snprintf(path, sizeof path, "%s/%s", dict_dir, e->d_name);
      size_t dl; uint8_t *db = read_file(path, &dl); if (!db) continue;
      memcpy(names[ndicts], e->d_name, l - 6); names[ndicts][l - 6] = 0;
      dicts[ndicts].name = names[ndicts]; dicts[ndicts].data = db; dicts[ndicts].size = dl; dict_bufs[ndicts] = db; ndicts++;
    }
    closedir(d);
  }
  hbcpack_options opts = { dicts, ndicts, 0, base, base_len };

  if (size_only) {
    size_t size = 0; hbcpack_status st = hbcpack_unpacked_size(in, in_len, &opts, &size);
    if (st != HBCPACK_OK) { fprintf(stderr, "error: %s\n", hbcpack_strerror(st)); return 1; }
    printf("%zu\n", size); return 0;
  }
  uint8_t *out = NULL; size_t out_len = 0;
  double t0 = now_ms();
  hbcpack_status st = hbcpack_unpack(in, in_len, &opts, &out, &out_len);
  double dt = now_ms() - t0;
  if (st != HBCPACK_OK) { fprintf(stderr, "error: %s\n", hbcpack_strerror(st)); return 1; }
  if (bench > 0) {
    double best = dt;
    for (int i = 0; i < bench; i++) {
      uint8_t *o2; size_t l2; double a = now_ms();
      if (hbcpack_unpack(in, in_len, &opts, &o2, &l2) != HBCPACK_OK) return 1;
      double b = now_ms() - a; if (b < best) best = b; hbcpack_free(o2);
    }
    printf("%zu -> %zu bytes, best of %d: %.2f ms, %.0f MB/s\n", in_len, out_len, bench + 1, best, (double)out_len / 1e6 / (best / 1e3));
  }
  FILE *f = fopen(argv[3], "wb"); if (!f || fwrite(out, 1, out_len, f) != out_len) { fprintf(stderr, "cannot write %s\n", argv[3]); return 1; }
  fclose(f);
  hbcpack_free(out); free(in); free(base);
  for (size_t i = 0; i < ndicts; i++) free(dict_bufs[i]);
  return 0;
}
