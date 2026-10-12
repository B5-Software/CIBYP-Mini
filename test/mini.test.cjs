const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { main, readCore, save } = require("../src/cli");
test("bundled shared core initializes all modes, serves v2 and exits without Electron", async (t) => {
  assert.equal(process.versions.electron, undefined);
  assert.equal(readCore(null), readCore());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-"));
  const host = await readCore().createNodeRuntime({ dataDir: dir });
  t.after(async () => {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const address = await host.start({
    port: 0,
    token: crypto.randomBytes(32).toString("hex"),
  });
  assert.ok(address.port);
  await host.api.setSettings({
    userProfile: { name: "Fixture", avatarFrame: "frame-001" },
  });
  const appearance = await host.dispatch({ method: "chat:appearance" });
  assert.match(appearance.user.frame, /<svg/);
  for (const mode of ["chat", "code", "babe"]) {
    const session = host.runtime.createSession({ mode });
    await host.runtime.initialize({ key: session.key });
    assert.ok(host.runtime.getSession(session.key).workspacePath);
  }
  await assert.rejects(
    readCore().createNodeRuntime({ dataDir: dir }),
    /already running/,
  );
});
test("init is repeat-safe and creates private credentials; mismatched core is refused", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await main(["init", "--data-dir", dir, "--port", "12001"]);
  const config = JSON.parse(fs.readFileSync(path.join(dir, "mini.json")));
  assert.match(config.token, /^[a-f0-9]{64}$/);
  await assert.rejects(main(["init", "--data-dir", dir]));
  fs.writeFileSync(
    path.join(dir, "core.cjs"),
    'throw new Error("must not run")',
  );
  save(path.join(dir, "manifest.json"), {
    protocol: 2,
    sha256: "a".repeat(64),
  });
  assert.throws(() => readCore(dir), /SHA-256 mismatch/);
});
test("updates reject a tampered binary and stage verified core without running it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-update-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  save(path.join(dir, "mini.json"), { token: "private" });
  const binary = Buffer.from(
    'throw new Error("downloads must never execute before restart")',
  );
  const sha256 = crypto.createHash("sha256").update(binary).digest("hex");
  let tampered = true;
  const fetchImpl = async (url) => {
    const body = url.includes("api.github.com")
      ? JSON.stringify([
          {
            draft: false,
            prerelease: false,
            assets: ["manifest.json", "core.cjs"].map((name) => ({
              name,
              browser_download_url:
                "https://github.com/B5-Software/CIBYP-Mini/releases/download/v0.1.0/" +
                name,
            })),
          },
        ])
      : url.endsWith("manifest.json")
        ? JSON.stringify({ version: "1.9.0-alpha.25", protocol: 2, sha256 })
        : tampered
          ? Buffer.from("wrong")
          : binary;
    return new Response(body);
  };
  const { update } = require("../src/update");
  await assert.rejects(update(dir, { fetchImpl }), /SHA-256 mismatch/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "mini.json"))).core,
    undefined,
  );
  tampered = false;
  const result = await update(dir, { fetchImpl });
  assert.equal(result.restartRequired, true);
  assert.equal(
    fs.readFileSync(path.join(result.directory, "core.cjs"), "utf8"),
    String(binary),
  );
  await update(dir, { fetchImpl });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "mini.json"))).previousCore,
    null,
    "repeated downloads preserve the rollback target",
  );
  const adapter = require("../src/update").adapter(dir, { fetchImpl });
  assert.equal((await adapter.check(() => {})).status, "up-to-date");
  assert.throws(() => adapter.install(), /No verified update/);
});

test("CLI and remote update channels share profile preferences and explicit overrides", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-channel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { channel } = require("../src/update");
  assert.equal(
    channel(dir),
    require("../package.json").version.includes("-") ? "preview" : "stable",
  );
  save(path.join(dir, "mini.json"), { updateChannel: "stable" });
  assert.equal(channel(dir), "stable");
  assert.equal(channel(dir, "preview"), "preview");
  assert.throws(() => channel(dir, "unknown"), /Invalid update channel/);
});
