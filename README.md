# CIBYP Mini

**Could I Be Your Partner's shared Agent backend, without Electron or a frontend.** Run it on a 64-bit SBC, NAS or server and connect the existing CIBYP remote clients. Chat, Code, Babe, persistent histories/context, automatic memory, shared todos, model routing, MCP, approvals, native subagents and automations reuse the desktop implementation.

![Checks](https://github.com/B5-Software/CIBYP-Mini/actions/workflows/check.yml/badge.svg)

Initial alpha: Node.js 24+, Linux x64/ARM64; Windows is covered for software portability. GPIO needs Linux chardev v2. No GUI, VM image, Code-OSS or mandatory Tor download. This repository is not published to npm.

## Install and start

```sh
git clone https://github.com/B5-Software/CIBYP-Mini.git
cd CIBYP-Mini
npm ci
node bin/cibyp-mini.cjs init --workspace /srv/cibyp-workspaces
node bin/cibyp-mini.cjs password
node bin/cibyp-mini.cjs serve
```

The default profile is `~/.local/share/cibyp-mini`; use `--data-dir PATH` or `CIBYP_MINI_HOME`. First initialization generates a private owner token and password hash. `password` reads hidden input (or stdin), never command-line arguments. Until changed, the owner token is also the access password. Profiles, credentials and uploaded files are created with owner-only permissions where supported; Windows profile ACLs remain an administrator responsibility.

Configure a provider using `init --settings /private/settings.json`, the existing owner-authenticated settings client, or v2 `settings.privatePatch` with an explicit `secrets.write` grant. Settings are the desktop schema, e.g. `llm.provider`, `llm.apiUrl`, `llm.model`, `llm.apiKey`, `llm.pool`. Ordinary settings reads omit credentials. Code sessions use server workspaces via `workspace.bind`; no VM is required. Shell sandbox policies fail closed if the platform cannot provide requested isolation; PTY requires optional `node-pty`.

```sh
node bin/cibyp-mini.cjs status
node bin/cibyp-mini.cjs doctor
node bin/cibyp-mini.cjs pair-client --scopes system.read,sessions.read,sessions.write,events.read,interactions.answer --output /private/client.json
node bin/cibyp-mini.cjs stop
```

Only one backend can write a profile. All connected frontends share its sessions and memory. Mini listens on loopback; expose it through a correctly authenticated HTTPS/WSS reverse proxy, SSH or Tor forwarding. Browser login uses the chosen password and optional TOTP. Owner tokens are broad; use scoped v2 credentials for integrations. Do not expose plain HTTP or place credentials in URLs.

## Device gateway and GPIO

```sh
node bin/cibyp-mini.cjs pair-device --device desk --policy examples/desk-policy.json --output /private/desk.json
node bin/cibyp-mini.cjs revoke-device --device desk
```

Provision the WSS gateway URL and device token over trusted USB/serial. The emitted loopback URL is for the host simulator; change it to your TLS gateway for a real board. `device.setPolicy` changes grants and forces a reconnect; revoked credentials stop authenticating. See [Remote](https://github.com/B5-Software/CIBYP-Remote) and [Micro](https://github.com/B5-Software/CIBYP-Micro).

For Linux GPIO:

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror native/gpio.c -o build-gpio
node bin/cibyp-mini.cjs serve --helper ./build-gpio --chip gpiochip0 --lines 17,27 --inputs 22
```

Explicit output offsets start LOW, explicit inputs remain inputs; input lines cannot be written. The persistent helper owns the line request and installs monotonic output deadlines. EOF/SIGTERM sets outputs LOW before releasing. The implementation calls the kernel's GPIO v2 ioctl API directly, avoiding a mandatory libgpiod dependency; it does not use deprecated sysfs or short-lived `gpioset`. Grant only required `/dev/gpiochip*` permissions, rather than running Mini as root. Pin numbers are chip offsets, not physical header pins. Board reservation/active-low mapping is the operator's responsibility in this alpha. An external circuit/watchdog is required where SIGKILL, power loss or a kernel failure must guarantee a safe level. Hardware qualification is still pending.

Custom Node tools use `host.tools.register(manifest, execute, policy)` from the shared Remote library. Trusted DS plugins can be explicitly listed in private `mini.json` as `plugins: [{id,entry:"/absolute/plugin/entry.js",config:{}}]`; they load through the existing capability translators. Their own SDK/package dependencies must be installed. Native subagents load that host on demand even with no plugins. Unsupported desktop capabilities fail explicitly instead of fabricating a window or VM.

## Service and updates

`deploy/cibyp-mini.service` is a systemd user-service example. Set absolute Node, entrypoint and profile paths before enabling it; journalctl supplies logs. SIGINT/SIGTERM drain shared storage, stop automations/MCP/terminals and release GPIO. `stop` refuses active tasks; service supervisors may still perform an intentional forced stop.

`update --channel stable|preview` fetches the official GitHub release manifest, validates protocol/version/size and SHA-256, then stages a separate core directory. Nothing downloaded executes during this command. Restart to select it; `rollback` selects the previous core. Startup restores the previous selection if the staged core fails hash/import verification. Failed settings/storage migration is not automatically undone. Full package/dependency updates require installing a new portable release; core updates cannot silently add native dependencies. The official manifest is fetched independently of any mirror; no unverified mirror fallback exists.

## Shared source and verification

`core/core.cjs` is generated **only** by the desktop repository's `scripts/build-node-core.cjs`; no second Agent implementation lives here. Its manifest records source version/provenance and SHA-256; source maps and license notices accompany it. To refresh from a local desktop checkout, run `node scripts/import-core.cjs /path/to/desktop/dist/node-core`. `npm test` verifies pure-Node import, all three modes, locking, credentials, integrity and staged updates. CI runs Linux x64/ARM64 and Windows, compiles the GPIO helper and audits dependencies.

A local Windows smoke measurement with one initialized session and the lazily loaded DS host was about 88 MiB RSS; that is not a guarantee for SBCs, large model contexts or plugins. Reference-board endurance, GPIO and power-loss tests are pending. GPL-3.0-or-later.
