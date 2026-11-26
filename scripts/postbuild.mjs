// Make the CLI entry executable and check it starts with a shebang.
import fs from 'node:fs';
const bin = new URL('../dist/cli/main.js', import.meta.url);
const src = fs.readFileSync(bin, 'utf8');
if (!src.startsWith('#!/usr/bin/env node')) throw new Error('dist/cli/main.js must start with a shebang');
fs.chmodSync(bin, 0o755);
