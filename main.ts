import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

const inputDir: string = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR || '/output';

interface Case {
  id: string;
  markdown: string;
}

const cases: Case[] = JSON.parse(readFileSync(inputDir + '/cases.json', 'utf8'));
const html: string[] = new Array<string>(cases.length);
for (let i: number = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(outputDir + '/html.json', JSON.stringify(html));
