/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
function readCore(directory = path.join(root, 'core')) {
  directory ||= path.join(root, 'core');
  const manifest = load(path.join(directory, 'manifest.json'));
  if (!manifest || manifest.protocol !== 2 || !/^[a-f0-9]{64}$/.test(manifest.sha256))
    throw new Error('Invalid core manifest');
  const file = path.join(directory, 'core.cjs');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (hash !== manifest.sha256) throw new Error('Core SHA-256 mismatch');
  return require(file);
}
async function rpc(config, method, params) {
  const id = crypto.randomUUID();
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Backend HTTP ' + response.status);
  const result = await response.json();
  if (result.id !== id) throw new Error('Mismatched RPC response');
  if (result.error) throw new Error(result.error.message + ' (' + result.error.data?.reason + ')');
  return result.result;
}
async function main(argv = process.argv.slice(2)) {
  const command = argv.shift() || 'help';
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (!/^--[a-z-]+$/.test(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--'))
      throw new Error('Use named options with values');
    const key = argv[i].slice(2);
    if (
      ![
        'data-dir',
        'port',
        'workspace',
        'core',
        'settings',
        'device',
        'policy',
        'output',
        'helper',
        'chip',
        'lines',
        'inputs',
        'scopes',
        'channel',
      ].includes(key)
    )
      throw new Error('Unknown option: ' + key);
    options[key] = argv[++i];
  }
  const dataDir = path.resolve(
    options['data-dir'] ||
      process.env.CIBYP_MINI_HOME ||
      path.join(os.homedir(), '.local/share/cibyp-mini'),
  );
  const configFile = path.join(dataDir, 'mini.json');
  let config = load(configFile, null);
  if (command === 'init') {
    if (config) throw new Error('Already initialized; existing credentials were preserved');
    const port = Number(options.port || 12000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    const token = crypto.randomBytes(32).toString('hex');
    config = {
      host: '127.0.0.1',
      port,
      token,
      passwordHash: await require('bcryptjs').hash(token, 12),
      workspaceRoot: path.resolve(options.workspace || path.join(dataDir, 'workspaces')),
    };
    save(configFile, config);
    if (options.settings)
      save(path.join(dataDir, 'settings.json'), load(path.resolve(options.settings)));
    console.log(
      'Initialized ' + dataDir + '\nCredentials: ' + configFile + '\nRun cibyp-mini serve',
    );
    return;
  }
  if (command === 'help') {
    console.log(
      'CIBYP Mini\nCommands: init, serve, status, stop, doctor, password, pair-client, pair-device, revoke-device, update, rollback\nOptions: --data-dir PATH --port PORT --workspace PATH --settings JSON\nDevice: --device ID --policy JSON --output PRIVATE_FILE\nClient: --scopes system.read,sessions.read,events.read --output PRIVATE_FILE\nLinux GPIO: serve --helper PATH --chip gpiochip0 --lines 17,27\nUpdate: --channel stable|preview (takes effect after restart)',
    );
    return;
  }
  if (!config) throw new Error('Run cibyp-mini init first');
  if (command === 'password') {
    const password = await require('./password').readPassword();
    if (password.length < 12 || Buffer.byteLength(password) > 72)
      throw new Error('Use 12–72 UTF-8 bytes for the access password');
    save(configFile, { ...config, passwordHash: await require('bcryptjs').hash(password, 12) });
    console.log('Access password changed. Restart Mini to apply.');
    return;
  }
  const connection = { ...config, url: 'http://127.0.0.1:' + config.port + '/remote/v2/rpc' };
  if (command === 'status') {
    console.log(JSON.stringify(await rpc(connection, 'system.health', {}), null, 2));
    return;
  }
  if (command === 'stop') {
    console.log(await rpc(connection, 'system.stop', { operationId: crypto.randomUUID() }));
    return;
  }
  if (command === 'doctor') {
    readCore(options.core || config.core);
    console.log(
      JSON.stringify(
        {
          node: process.version,
          arch: process.arch,
          platform: process.platform,
          dataDir,
          core: 'SHA-256 verified',
          listen: connection.url,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'update') {
    if (options.channel && !['stable', 'preview'].includes(options.channel))
      throw new Error('Invalid update channel');
    const result = await require('./update').update(dataDir, {
      preview: options.channel === 'preview',
    });
    console.log(
      'Core ' +
        result.version +
        ' verified. Restart Mini to install. Use rollback to return to the previous core.',
    );
    return;
  }
  if (command === 'rollback') {
    save(configFile, {
      ...config,
      core: config.previousCore || null,
      previousCore: config.core || null,
    });
    console.log('Previous core selected. Restart Mini.');
    return;
  }
  if (command === 'pair-client') {
    if (!options.output || fs.existsSync(path.resolve(options.output)))
      throw new Error('A new private output file is required');
    const result = await rpc(connection, 'client.issue', {
      label: 'Remote client',
      scopes: (options.scopes || 'system.read,sessions.read,events.read').split(','),
      operationId: crypto.randomUUID(),
    });
    save(path.resolve(options.output), { ...result, url: 'http://127.0.0.1:' + config.port });
    console.log('Scoped credentials saved to ' + path.resolve(options.output));
    return;
  }
  if (command === 'pair-device') {
    if (!options.device || !options.policy || !options.output)
      throw new Error('device, policy and private output file are required');
    if (fs.existsSync(path.resolve(options.output))) throw new Error('Output already exists');
    const credentials = await rpc(connection, 'device.provision', {
      deviceId: options.device,
      policy: load(path.resolve(options.policy)),
      operationId: crypto.randomUUID(),
    });
    save(path.resolve(options.output), {
      ...credentials,
      gatewayUrl: 'ws://127.0.0.1:' + config.port + '/remote/v2/devices',
    });
    console.log('Device credentials saved to ' + path.resolve(options.output));
    return;
  }
  if (command === 'revoke-device') {
    console.log(
      await rpc(connection, 'device.revoke', {
        deviceId: options.device,
        operationId: crypto.randomUUID(),
      }),
    );
    return;
  }
  if (command !== 'serve') throw new Error('Unknown command: ' + command);
  let core;
  try {
    core = readCore(options.core || config.core);
  } catch (error) {
    if (options.core || !config.core) throw error;
    config = { ...config, core: config.previousCore || null, previousCore: null };
    save(configFile, config);
    console.error('Selected core failed verification; previous core restored: ' + error.message);
    core = readCore(config.core);
  }
  const host = await core.createNodeRuntime({
    dataDir,
    workspaceRoot: config.workspaceRoot,
    plugins: config.plugins || [],
    updateAdapter: require('./update').adapter(dataDir),
    product: { name: 'CIBYP Mini', version: require('../package.json').version },
  });
  let closing = false,
    stopGpio;
  const close = async () => {
    if (closing) return;
    closing = true;
    stopGpio?.();
    await host.close();
  };
  host.eventBus.subscribe('host:shutdown', () => close().catch(console.error));
  process.once('SIGINT', () => close().catch(console.error));
  process.once('SIGTERM', () => close().catch(console.error));
  try {
    if (options.helper) stopGpio = require('./gpio').registerGpio(host.tools, options);
    const address = await host.start({
      host: config.host,
      port: config.port,
      token: config.token,
      config: {
        passwordHash: config.passwordHash,
        enable2FA: !!config.enable2FA,
        totpSecret: config.totpSecret,
      },
    });
    save(path.join(dataDir, 'endpoint.json'), { ...address, protocol: 2, pid: process.pid });
    console.log('CIBYP Mini listening at ' + address.url + '\nProfile: ' + dataDir);
  } catch (error) {
    await close();
    throw error;
  }
}
module.exports = { main, readCore, save, load, rpc };
