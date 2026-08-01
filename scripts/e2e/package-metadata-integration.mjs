import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const EXPECTED_PACKAGE_NAME = "@wisteria30/delegate-claude";
const EXPECTED_EXECUTABLE_NAME = "delegate-claude";
const EXPECTED_EXECUTABLE_PATH = "dist/index.js";
const UPSTREAM_COPYRIGHT = "Copyright (c) 2026 claude-code-mcp contributors";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNpmPack(args) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, ["pack", "--ignore-scripts", "--json", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm pack failed with status ${result.status}: ${result.stderr.trim()}`);
  }
  const packs = JSON.parse(result.stdout);
  assert(Array.isArray(packs) && packs.length === 1, "npm pack returned unexpected metadata");
  return packs[0];
}

function readTarEntries(tarballPath) {
  const archive = gunzipSync(readFileSync(tarballPath));
  const entries = new Map();
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const readString = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const sizeText = readString(124, 12).trim();
    const size = sizeText === "" ? 0 : Number.parseInt(sizeText, 8);
    assert(Number.isSafeInteger(size), `invalid tar entry size for ${entryPath}`);

    const dataOffset = offset + 512;
    entries.set(entryPath, archive.subarray(dataOffset, dataOffset + size));
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }

  return entries;
}

function requiredEntry(entries, entryPath) {
  const entry = entries.get(entryPath);
  assert(entry !== undefined, `package tarball is missing ${entryPath}`);
  return entry;
}

function verifyDryRunMetadata(metadata) {
  assert(metadata.name === EXPECTED_PACKAGE_NAME, "npm pack package name mismatch");
  const files = new Map(metadata.files.map((file) => [file.path, file]));
  for (const filePath of ["package.json", "LICENSE", "NOTICE.md", EXPECTED_EXECUTABLE_PATH]) {
    assert(files.has(filePath), `npm pack dry-run is missing ${filePath}`);
  }
  assert(
    (files.get(EXPECTED_EXECUTABLE_PATH).mode & 0o111) !== 0,
    "packed executable entry is not executable"
  );
}

function verifyTarball(tarballPath) {
  const entries = readTarEntries(tarballPath);
  const packageJson = JSON.parse(requiredEntry(entries, "package/package.json").toString("utf8"));
  const license = requiredEntry(entries, "package/LICENSE").toString("utf8");
  const notice = requiredEntry(entries, "package/NOTICE.md").toString("utf8");

  assert(packageJson.name === EXPECTED_PACKAGE_NAME, "tarball package name mismatch");
  assert(
    packageJson.bin?.[EXPECTED_EXECUTABLE_NAME] === EXPECTED_EXECUTABLE_PATH &&
      Object.keys(packageJson.bin).length === 1,
    "tarball executable mapping mismatch"
  );
  assert(license.includes(UPSTREAM_COPYRIGHT), "tarball LICENSE lost the upstream copyright");
  assert(notice.includes(UPSTREAM_COPYRIGHT), "tarball NOTICE lost the upstream copyright");

  return packageJson;
}

function main() {
  const dryRun = runNpmPack(["--dry-run"]);
  verifyDryRunMetadata(dryRun);

  const packDirectory = mkdtempSync(path.join(os.tmpdir(), "delegate-claude-pack-"));
  try {
    const packed = runNpmPack(["--pack-destination", packDirectory]);
    assert(packed.name === dryRun.name, "dry-run and tarball package names differ");
    const packageJson = verifyTarball(path.join(packDirectory, packed.filename));
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          package: packageJson.name,
          executable: EXPECTED_EXECUTABLE_NAME,
          executablePath: packageJson.bin[EXPECTED_EXECUTABLE_NAME],
          files: packed.entryCount,
          licenseNotice: UPSTREAM_COPYRIGHT,
        },
        null,
        2
      )}\n`
    );
  } finally {
    rmSync(packDirectory, { recursive: true, force: true });
  }
}

main();
