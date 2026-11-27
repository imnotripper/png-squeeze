[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/imnotripper/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/imnotripper/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

# png-squeeze — lossless PNG re-encoder for 1280×720 screenshots

Entry for [make.fun's "Squeeze screenshots into the smallest PNG, 27 November 2026" bounty](https://make.fun/bounty/png-squeeze-01-run-20261127) ($100 in USDC).

`main.ts` (Node 22, zero dependencies) reads each screenshot from `/input/<id>/image.png` and writes the same image, losslessly, in as few bytes as possible to `/output/<id>/image.png`.

## How it works

1. **Decode** the stored type-6 input PNG to raw RGBA.
2. **Pick the cheapest exact representation** for the image:
   - ≤ 256 unique colours (and not grey) → palette (type 3), entries ordered by frequency, plus `tRNS` when alpha varies;
   - all grey → grey (type 0), or grey+alpha (type 4), or grey + `tRNS` when every transparent pixel shares one grey value no opaque pixel uses;
   - colour, opaque → RGB (type 2); colour with a single shared transparent RGB → RGB + `tRNS`;
   - otherwise RGBA (type 6).
3. **Filter** every row with the best of three strategies, decided by the real deflated size: per-row minimum-sum, fixed Paeth, and per-row entropy (the filter whose bytes concentrate most). The winner's stream gets a second deflate try with the filtered strategy.
4. **Deflate** at zlib level 9 and write a minimal PNG: `IHDR`, `PLTE`/`tRNS` when needed, one `IDAT`, `IEND`. No other chunks, bit depth 8, never interlaced.

The program is fully deterministic — no clock, no randomness, no network — so two runs on the same set produce byte-identical output. It runs all 8 instances in ~16s on this machine, inside the 60s wall budget.

## Practice-set score (kit scorer, local)

| instance | theme | representation | bytes | scale | points |
|----------|-------|----------------|------:|------:|-------:|
| i001 | flat | palette | 14,642 | 13,547 | 613 |
| i002 | rich | RGB | 57,675 | 55,063 | 635 |
| i003 | alpha | RGBA | 108,894 | 107,892 | 660 |
| i004 | grey | grey | 112,418 | 110,521 | 655 |
| i005 | flat | palette | 18,744 | 18,669 | 664 |
| i006 | rich | RGB | 179,080 | 185,295 | 689 |
| i007 | alpha | RGBA | 78,445 | 64,285 | 520 |
| i008 | grey | grey | 27,507 | 26,807 | 649 |

**Total: 635,696** (house baseline fixed-paeth 1.0.0 scores 420,399 on the same set; the scale compressor's level is 666,667).

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=path/to/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Licence

MIT — see [LICENSE](LICENSE).
