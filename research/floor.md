# HBC compression floor

Strongest general-purpose compressors on the 104 Hermes bytecode bundles (`bundles/<slug>/index.android.hbc`, 201.83 MB), plus the three starred compressors on the minified JS bundles (`index.android.bundle`, 184.66 MB) for comparison. Per-file rows: `floor.csv` in this folder.

## Conditions

- Each file x compressor: one compress run and one decompress run, single wall-clock run each.
- Timing: `time.perf_counter()` around `subprocess`, with `nice -n 10` on every tool. Includes process spawn and writing the output file. Decode output goes to a file inside the timer; `cmp` runs after the timer stops.
- Concurrency: at most 2 jobs in flight at once.
- Round trip: every decoded file checked with `cmp -s` against the original. **1456 of 1456 round trips identical, 0 failures.**
- Host: macOS 27.0.1, arm64, 18 logical CPUs, 48 GiB RAM. The machine was shared with other work, so timings are noisy. Small-file medians are dominated by process start-up (about 5 to 10 ms).
- MB = 10^6 bytes. Aggregate decode MB/s = total original bytes / total decode seconds. Median decode MB/s = median of per-file MB/s.
- `floor.csv` columns: `slug, format, compressor, original_bytes, compressed_bytes, compress_seconds, decompress_seconds`, plus `roundtrip_ok` (1 or 0) and `status`.

## 1. Totals and medians

HBC (201.83 MB, 104 files):

| compressor | total comp MB | total ratio % | median per-file ratio % | median compress s | median decode s | max compress s (file) | decode MB/s aggregate | decode MB/s median |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| zstd -22 --ultra | 73.62 | 36.48 | 37.43 | 0.215 | 0.0071 | 1.59 | 256.4 | 229.3 |
| zstd -22 --ultra --long=27 | 73.62 | 36.48 | 37.43 | 0.255 | 0.0072 | 2.00 | 240.2 | 213.9 |
| xz -9e | 65.77 | 32.59 | 33.58 | 0.275 | 0.0259 | 1.88 | 66.8 | 62.9 |
| xz tuned pb=0 (lc=3, lp=0) | 65.84 | 32.62 | 33.57 | 0.249 | 0.0248 | 1.55 | 68.5 | 66.1 |
| xz tuned lc=0, lp=2, pb=2 | 66.17 | 32.78 | 33.88 | 0.284 | 0.0261 | 1.72 | 67.6 | 62.6 |
| xz tuned lc=1, lp=0, pb=2 | 65.72 | 32.56 | 33.61 | 0.240 | 0.0240 | 1.66 | 71.7 | 67.4 |
| xz tuned lc=0, lp=0, pb=2 | 65.86 | 32.63 | 33.65 | 0.229 | 0.0236 | 1.57 | 72.5 | 68.3 |
| brotli -q 11 --large_window=30 | 68.51 | 33.94 | 34.84 | 2.354 | 0.0105 | 16.45 (jellify-music__app) | 172.4 | 153.1 |
| **zpaq -m5** | **61.79** | **30.62** | **32.01** | 2.786 | 2.836 | 15.13 (jellify-music__app) | **0.6** | 0.6 |
| bzip2 -9 | 88.41 | 43.81 | 45.61 | 0.070 | 0.0362 | 0.36 | 47.4 | 45.8 |
| bzip3 -b 511 | 80.44 | 39.85 | 40.97 | 0.258 | 0.2495 | 0.77 | 7.3 | 6.4 |

JS bundles (184.66 MB, 104 files), starred compressors only:

| compressor | total comp MB | total ratio % | median per-file ratio % | median compress s | median decode s | max compress s (file) | decode MB/s aggregate | decode MB/s median |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| zstd -22 --ultra | 35.87 | 19.42 | 20.25 | 0.253 | 0.0061 | 1.56 | 279.6 | 230.5 |
| xz -9e | 34.09 | 18.46 | 19.33 | 0.229 | 0.0140 | 1.57 | 112.6 | 103.1 |
| brotli -q 11 --large_window=30 | 33.91 | 18.36 | 19.15 | 1.346 | 0.0071 | 6.66 | 237.3 | 204.9 |

Failures: 0 in all 1456 rows.

## 2. Gap: zstd -22 vs best per file (HBC)

- Best per file: zpaq -m5 on all 104 files.
- Per-file gap, median: **17.70%** (range 13.96% to 24.86%).
- Total gap: **19.14%** (73.62 MB vs 61.79 MB).
- Formula: per-file gap = (zstd-22 bytes / best bytes - 1) x 100. Total gap = (sum of zstd-22 bytes / sum of best bytes - 1) x 100.
- `zstd --long=27` gives no change against `zstd -22` (total -0.001%). Level 22 already uses a 2^27 window, and these files are under 9 MB.

## 3. xz literal and position tuning (HBC)

Delta vs default `xz -9e` (lc=3, lp=0, pb=2). Negative means smaller.

| variant | total MB | total delta % | median per-file delta % | files smaller than default |
|---|---:|---:|---:|---:|
| `-9e` (lc=3, lp=0, pb=2) | 65.77 | 0 | 0 | - |
| `preset=9e,pb=0` (lc=3, lp=0, pb=0) | 65.84 | +0.11 | +0.03 | 40/104 |
| `preset=9e,lc=0,lp=2,pb=2` | 66.17 | +0.60 | +0.75 | 0/104 |
| `preset=9e,lc=1,lp=0,pb=2` | 65.72 | **-0.07** | -0.05 | 70/104 |
| `preset=9e,lc=0,lp=0,pb=2` | 65.86 | +0.13 | +0.16 | 16/104 |

- Best by total bytes: lc=1, lp=0, pb=2 (-0.07%). Oracle best-of-5 per file gives 65.70 MB, so per-file selection adds nothing material.

## 4. xz (best variant) vs zpaq -m5 (HBC)

- Total: xz is **+6.36%** larger (65.72 MB vs 61.79 MB).
- Per-file median: **+5.32%**.
- The default `-9e` is +6.43% vs zpaq in total.
- zpaq is smaller than every xz variant on all 104 files.

## 5. Starred compressors, HBC vs JS

| compressor | HBC total ratio % | JS total ratio % | HBC median ratio % | JS median ratio % |
|---|---:|---:|---:|---:|
| zstd -22 | 36.48 | 19.42 | 37.43 | 20.25 |
| xz -9e | 32.59 | 18.46 | 33.58 | 19.33 |
| brotli -q 11 --large_window=30 | 33.94 | 18.36 | 34.84 | 19.15 |

The HBC files are about 1.8 times larger after compression than the JS source for the same apps, so bytecode carries less redundancy than the minified text.

## 6. Interpretation

- **Headroom for context modelling.** zpaq -m5 beats the best LZMA variant by 6.4% in total and by 5.3% per file (median), and it wins on all 104 files. Against zstd -22 the gap is 19.1%. That is the headroom a general context-mixing model gets over LZ on this data. Its decode speed is the cost: 0.6 MB/s here, against 67 MB/s for xz -9e and 256 MB/s for zstd -22. A format-specific compressor needs to beat 30.6% total (61.8 MB) at a decode speed a device can use.
- **LZMA literal and position tuning.** All five variants are within 0.7% of each other in total bytes. The best one (lc=1, lp=0, pb=2) is only 0.07% smaller than the default. pb=0 is 0.11% larger, with pb=0 smaller on only 40 of 104 files. lp=2 is 0.47% larger than lp=0 at lc=0. The data shows no clear exploitable 4-byte alignment through LZMA's position or literal contexts. This is weak evidence: it only tests generic position contexts. A model that parses the bytecode instruction and operand fields would need its own test.
- **Practical floor.** Plain `xz -9e` is close to the best LZMA setting for this data, so it is the right LZ baseline.

## 7. Exact commands

Input `IN` is `bundles/<slug>/index.android.hbc` (or `index.android.bundle` for JS). `C` is the compressed file, `D` the decoded file. Each run is prefixed with `nice -n 10`.

```
zstd-22:            zstd --ultra -22 -c IN > C          decode: zstd -d -c C > D
zstd-22-long27:     zstd --ultra -22 --long=27 -c IN > C   decode: zstd -d -c C > D
xz-9e:              xz -9e -c IN > C                    decode: xz -dc C > D
xz-9e-pb0:          xz --format=xz --lzma2=preset=9e,pb=0 -c IN > C              decode: xz -dc C > D
xz-9e-lc0lp2pb2:    xz --format=xz --lzma2=preset=9e,lc=0,lp=2,pb=2 -c IN > C    decode: xz -dc C > D
xz-9e-lc1lp0pb2:    xz --format=xz --lzma2=preset=9e,lc=1,lp=0,pb=2 -c IN > C    decode: xz -dc C > D
xz-9e-lc0lp0pb2:    xz --format=xz --lzma2=preset=9e,lc=0,lp=0,pb=2 -c IN > C    decode: xz -dc C > D
brotli-q11-lw30:    brotli -q 11 --large_window=30 -c IN > C   decode: brotli -d --large_window=30 -c C > D
bzip2-9:            bzip2 -9 -c IN > C                  decode: bzip2 -dc C > D
bzip3-b511:         bzip3 -b 511 -c IN > C              decode: bzip3 -d -c C > D
zpaq-m5 (cwd = bundle dir):  zpaq a C.zpaq index.android.hbc -m5
zpaq-m5 decode (cwd = fresh empty dir):  zpaq x C.zpaq   (writes index.android.hbc)
verify:             cmp -s D IN
```

zpaq stores the path exactly as given, so it runs from the bundle directory with a bare file name. Extraction goes into a fresh empty directory, because `zpaq x` skips files that already exist.

## 8. Tool versions and environment

- zstd 1.5.7 (`/opt/homebrew/bin/zstd`, Homebrew)
- xz 5.8.4 (`/opt/homebrew/bin/xz`, Homebrew)
- brotli 1.2.0 (Homebrew, installed for this run)
- zpaq v7.15 (Homebrew formula 7.15_1, installed for this run)
- bzip2 1.0.8 (`/usr/bin/bzip2`)
- bzip3 1.5.4 (Homebrew, installed for this run)
- Driver: Python 3.12.14, `subprocess` plus `time.perf_counter()`
- Corpus: manifest toolchain `hermes-compiler 250829098.0.9`, bytecode version 98, `hermesc -O`

## 9. Deviations and notes

- **Not measured:** 7zz / 7z (PPMd) and bsc are not installed, and Homebrew is not on the allowed install list, so they were skipped. `lzma` is present but not in the requested set.
- **Added variants:** `preset=9e,pb=0` (lc and lp at defaults) and `lc=0,lp=0,pb=2` as the control for lp=2. Both were run in full.
- **Homebrew side effect:** `brew install brotli zpaq bzip3` also ran `brew cleanup`, which removed the old xz 5.8.3 keg and some caches. xz 5.8.4 is the active binary and was verified.
- **zpaq:** `-m5` throughout. Slowest file was 15.1 s to compress (jellify-music__app, 8.9 MB), well under the 2-minute limit, so no `-m4` fallback.
- **Timing:** single runs, so decode medians for small files are dominated by spawn overhead. Aggregate MB/s is the more reliable figure.
- **Scratch files:** all temporary files were under the session scratchpad `floor/` directory and were deleted afterwards.
