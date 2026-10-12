/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { spawn } = require('node:child_process'),
  path = require('node:path');
const { createInterface } = require('node:readline');
function registerGpio(tools, options) {
  if (process.platform !== 'linux') throw new Error('Native GPIO requires Linux GPIO chardev v2');
  const chip = options.chip || 'gpiochip0';
  if (!/^gpiochip\d+$/.test(chip)) throw new Error('Invalid GPIO chip');
  const parse = (value) =>
    value
      ? String(value)
          .split(',')
          .map((v) => {
            if (!/^\d{1,5}$/.test(v)) throw new Error('Explicit GPIO lines required');
            return Number(v);
          })
      : [];
  const outputs = parse(options.lines),
    inputs = parse(options.inputs),
    lines = [...outputs, ...inputs];
  if (!lines.length || lines.length > 64 || new Set(lines).size !== lines.length)
    throw new Error('Invalid GPIO lines');
  const child = spawn(
    path.resolve(options.helper),
    ['/dev/' + chip, ...outputs.map((v) => 'out:' + v), ...inputs.map((v) => 'in:' + v)],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  let ready = false,
    pending,
    dead = false;
  const fail = (error) => {
    dead = true;
    pending?.reject(error);
    pending = null;
  };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('GPIO helper exited; pins released')));
  createInterface({ input: child.stdout }).on('line', (value) => {
    if (value === 'READY') {
      ready = true;
      return;
    }
    if (!pending) {
      child.kill();
      return;
    }
    const { resolve, reject } = pending;
    pending = null;
    /^OK [01]$/.test(value)
      ? resolve({ ok: true, value: Number(value.slice(3)) })
      : reject(new Error('GPIO I/O failed'));
  });
  const resources = lines.map((v) => chip + ':' + v);
  const disposers = [];
  for (const write of outputs.length ? [false, true] : [false])
    disposers.push(
      tools.register(
        {
          name: write ? 'gpio_write' : 'gpio_read',
          description: write
            ? 'Write explicitly granted GPIO; returns LOW when the lease/deadline ends'
            : 'Read explicitly configured GPIO input/output level',
          inputSchema: {
            type: 'object',
            properties: {
              resource: {
                type: 'string',
                enum: write ? outputs.map((v) => chip + ':' + v) : resources,
              },
              ...(write ? { value: { type: 'integer', minimum: 0, maximum: 1 } } : {}),
            },
            required: write ? ['resource', 'value'] : ['resource'],
            additionalProperties: false,
          },
          execution: { requiresLease: write, timeoutMs: 5000 },
        },
        async (input, context) => {
          if (!ready || dead) throw new Error('GPIO helper is not ready');
          if (pending) throw new Error('GPIO helper is busy');
          const line = input.resource.split(':')[1],
            budget = Math.max(
              1,
              Math.min(
                context.remainingMs,
                context.lease ? context.lease.until - performance.now() : 5000,
              ),
            );
          return new Promise((resolve, reject) => {
            const abort = () => {
              fail(new Error('GPIO acknowledgement unknown'));
              child.kill();
            };
            const cleanup = () => context.signal.removeEventListener('abort', abort);
            pending = {
              resolve: (value) => {
                cleanup();
                resolve(value);
              },
              reject: (error) => {
                cleanup();
                reject(error);
              },
            };
            context.signal.addEventListener('abort', abort, { once: true });
            child.stdin.write(
              write ? `SET ${line} ${input.value} ${Math.floor(budget)}\n` : `GET ${line}\n`,
              (error) => {
                if (error) abort();
              },
            );
          });
        },
        { allow: (input) => resources.includes(input.resource) },
      ),
    );
  const stop = () => {
    for (const dispose of disposers) dispose();
    child.stdin.end();
  };
  process.once('exit', stop);
  return stop;
}
module.exports = { registerGpio };
