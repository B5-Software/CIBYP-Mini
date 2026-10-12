/* SPDX-License-Identifier: GPL-3.0-or-later */
"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { save, load } = require("./cli");
const REPO = "B5-Software/CIBYP-Mini";
async function get(url, limit, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "CIBYP-Mini" },
    redirect: "follow",
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error("Update download HTTP " + response.status);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error("Update exceeds size limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function check({ preview = false, fetchImpl = fetch } = {}) {
  const releases = JSON.parse(
    await get(
      "https://api.github.com/repos/" + REPO + "/releases?per_page=20",
      2 * 1024 * 1024,
      fetchImpl,
    ),
  );
  const release = releases.find((r) => !r.draft && (preview || !r.prerelease));
  return release || null;
}
async function describe(release, fetchImpl) {
  if (!release) throw new Error("No published release on this channel");
  const asset = (name) => {
    const value = release.assets.find((a) => a.name === name);
    if (
      !value ||
      !value.browser_download_url.startsWith(
        "https://github.com/" + REPO + "/releases/download/",
      )
    )
      throw new Error("Missing trusted update asset: " + name);
    return value.browser_download_url;
  };
  const manifest = JSON.parse(
    await get(asset("manifest.json"), 65536, fetchImpl),
  );
  if (
    manifest.protocol !== 2 ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version) ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  )
    throw new Error("Invalid update manifest");
  return { manifest, url: asset("core.cjs") };
}
async function update(dataDir, { preview = false, fetchImpl = fetch } = {}) {
  const release = await check({ preview, fetchImpl });
  const { manifest, url } = await describe(release, fetchImpl);
  const binary = await get(url, 16 * 1024 * 1024, fetchImpl);
  if (
    crypto.createHash("sha256").update(binary).digest("hex") !== manifest.sha256
  )
    throw new Error("Update SHA-256 mismatch");
  // Verify first, then activate only at the next process start. Never execute downloads here.
  const directory = path.join(dataDir, "cores", manifest.sha256);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "core.cjs"), binary, { mode: 0o600 });
  save(path.join(directory, "manifest.json"), manifest);
  const configFile = path.join(dataDir, "mini.json"),
    config = load(configFile);
  if (config.core !== directory)
    save(configFile, {
      ...config,
      previousCore: config.core || null,
      core: directory,
    });
  return {
    version: release.tag_name?.replace(/^v/, "") || manifest.version,
    coreVersion: manifest.version,
    directory,
    restartRequired: true,
  };
}
function adapter(dataDir, { fetchImpl = fetch } = {}) {
  let state = { status: "idle" },
    pending;
  const preview = () =>
    load(path.join(dataDir, "mini.json"), {}).updateChannel === "preview" ||
    (load(path.join(dataDir, "mini.json"), {}).updateChannel !== "stable" &&
      require("../package.json").version.includes("-"));
  return {
    status: () => state,
    async check(publish) {
      const release = await check({ preview: preview(), fetchImpl });
      const { manifest } = release ? await describe(release, fetchImpl) : {};
      const config = load(path.join(dataDir, "mini.json"), {});
      const installed = load(
        path.join(
          config.core || path.resolve(__dirname, "../core"),
          "manifest.json",
        ),
        {},
      );
      state = {
        status:
          !manifest || installed.sha256 === manifest.sha256
            ? "up-to-date"
            : "available",
        version: release?.tag_name || require("../package.json").version,
      };
      publish(state);
      return state;
    },
    async download(publish) {
      if (pending) return pending;
      state = { status: "downloading" };
      publish(state);
      pending = update(dataDir, { preview: preview(), fetchImpl })
        .then(
          (result) => {
            state = {
              status: "ready",
              version: result.version,
              restartRequired: true,
              sha256Verified: true,
            };
            publish(state);
            return state;
          },
          (error) => {
            state = { status: "error", error: error.message };
            publish(state);
            throw error;
          },
        )
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    install: () => {
      if (state.status !== "ready")
        throw new Error("No verified update is ready");
      return {
        ...state,
        restartRequired: true,
        message:
          "Restart the Mini service to install; active tasks are never interrupted automatically",
      };
    },
  };
}
module.exports = { update, check, adapter };
