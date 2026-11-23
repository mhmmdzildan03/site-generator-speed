# site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/mhmmdzildan03/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/mhmmdzildan03/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in replacement for makefun-site 1.0.0, the reference static site generator of make.fun's "Build a static site faster" bounty. `solve.js` exports `run(input)`, which returns the output tree makefun-site's build returns for a site — every page's index.html, the index and tag pages, the static files and build-report.txt — byte for byte, in a fraction of the CPU time. Front matter is scanned by offsets instead of split-and-rejoin, slugs and long dates are memoised per build, the Markdown lexer classifies lines with direct character checks, the inline renderer copies plain runs in bulk, and templates are compiled to plain JavaScript functions instead of being walked as a tree. No state survives a build, so each case is answered alone.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`), answers each with `run`, and writes the answers to `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR/answers.json`). Node 22, no dependencies.

---

<sub>Entered on [make.fun](https://make.fun/?ref=n8m845w8&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
