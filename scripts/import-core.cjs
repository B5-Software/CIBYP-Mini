/* SPDX-License-Identifier: GPL-3.0-or-later */
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const source = path.resolve(process.argv[2] || ''),
  destination = path.resolve(__dirname, '../core');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
const bytes = fs.readFileSync(path.join(source, 'core.cjs'));
if (
  manifest.protocol !== 2 ||
  crypto.createHash('sha256').update(bytes).digest('hex') !== manifest.sha256
)
  throw new Error('Unverified core');
fs.mkdirSync(destination, { recursive: true });
for (const name of [
  'core.cjs',
  'core.cjs.map',
  'manifest.json',
  'LICENSE',
  'i18n-sources.json',
  'THIRD-PARTY-NOTICES.json',
])
  fs.copyFileSync(path.join(source, name), path.join(destination, name));
console.log('Imported verified shared core ' + manifest.version);
