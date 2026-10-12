/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
async function readPassword() {
  if (!process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 4096) throw new Error('Password input is too long');
    }
    return input.replace(/\r?\n$/, '');
  }
  const { emitKeypressEvents } = require('node:readline');
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  async function ask(prompt) {
    process.stderr.write(prompt);
    let value = '';
    return new Promise((resolve, reject) => {
      const key = (text, event = {}) => {
        if (event.ctrl && event.name === 'c') {
          cleanup();
          reject(new Error('Cancelled'));
        } else if (event.name === 'return') {
          cleanup();
          resolve(value);
        } else if (event.name === 'backspace') value = [...value].slice(0, -1).join('');
        else if (
          !event.ctrl &&
          !event.meta &&
          text &&
          !/[\x00-\x1f\x7f]/.test(text) &&
          value.length < 1024
        )
          value += text;
      };
      const cleanup = () => {
        process.stdin.off('keypress', key);
        process.stderr.write('\n');
      };
      process.stdin.on('keypress', key);
    });
  }
  try {
    const first = await ask('New access password (hidden): '),
      second = await ask('Confirm password (hidden): ');
    if (first !== second) throw new Error('Passwords do not match');
    return first;
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
module.exports = { readPassword };
