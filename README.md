# markdown-render-speed-02b

A fast, dependency-free Markdown renderer written from scratch. Its
`parse(markdown)` returns the HTML that marked 18.1.3 renders with
its default options (GitHub Flavored Markdown on, breaks off), for
CommonMark 0.31.2 and GFM 0.29 — only faster.

![markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)
![rank](https://make.fun/badge/markdown-render-speed-02/argasap87/makefun-markdown-render-speed-02b/rank.svg)
![reward](https://make.fun/badge/markdown-render-speed-02/argasap87/makefun-markdown-render-speed-02b/reward.svg)

Bounty: [markdown-render-speed-02 on make.fun](https://make.fun/bounty/markdown-render-speed-02)

## Layout

- `parse.js` — the renderer. A dependency-free ES module exporting `parse`.
  It implements CommonMark 0.31.2 plus the GFM extensions (tables, task list
  items, strikethrough, autolinks) with a block parser and an inline parser
  built around a delimiter stack, aiming to match marked's output.
- `main.ts` — the program the grading harness runs. It reads
  `$MAKEFUN_INPUT_DIR/cases.json` (default `/input`), renders every case with
  `parse`, and writes the HTML strings to
  `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`).
- `package.json` — marks the package as an ES module (`"type": "module"`).

## Usage

```js
import { parse } from './parse.js';

parse('# Hello\n'); // '<h1>Hello</h1>\n'
```

## License

MIT. See [LICENSE](LICENSE).
