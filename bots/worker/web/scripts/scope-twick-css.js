#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '../node_modules/@twick/video-editor/dist/video-editor.css');
const OUTPUT = path.join(__dirname, '../public/twick-editor-scoped.css');

const CONFLICT_CLASSES = [
  'btn',
  'btn-primary',
  'btn-secondary',
  'btn-danger',
  'btn-ghost',
  'btn-outline',
  'card',
  'input',
  'input-dark',
  'flex',
  'flex-col',
  'flex-row',
  'flex-container',
  'items-center',
  'justify-center',
  'justify-between',
  'gap-1',
  'gap-2',
  'gap-3',
  'gap-4',
  'w-full',
  'h-full',
  'text-sm',
  'text-base',
  'text-lg',
  'font-bold',
  'icon-xs',
  'icon-sm',
  'icon-md',
  'icon-lg',
  'icon-margin',
  'text-gradient',
  'text-gradient-blue',
  'text-gradient-purple',
  'grid-auto-fit',
  'grid-auto-fill',
  'backdrop-blur-sm',
  'backdrop-blur-md',
  'backdrop-blur-lg',
  'custom-scrollbar',
  'glass',
  'glow-purple',
  'glow-blue',
  'animate-spin',
];

if (!fs.existsSync(INPUT)) {
  console.error(`❌ Twick CSS 원본을 찾지 못했습니다: ${INPUT}`);
  process.exit(1);
}

let css = fs.readFileSync(INPUT, 'utf8');

for (const cls of CONFLICT_CLASSES) {
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(?<=[,{;\\s])\\.(${escaped})(?=[\\s{:,])`, 'g');
  css = css.replace(regex, '.twick-scope .$1');
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, css, 'utf8');

console.log(`✅ Scoped Twick CSS → ${OUTPUT} (${(css.length / 1024).toFixed(1)}KB)`);
