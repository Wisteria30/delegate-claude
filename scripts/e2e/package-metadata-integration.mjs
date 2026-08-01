import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const EXPECTED_PACKAGE_NAME = "@wisteria30/delegate-claude";
const EXPECTED_EXECUTABLE_NAME = "delegate-claude";
const EXPECTED_EXECUTABLE_PATH = "dist/index.js";
const EXPECTED_NODE_SHEBANG = "#!/usr/bin/env node\n";
const UPSTREAM_COPYRIGHT = "Copyright (c) 2026 claude-code-mcp contributors";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNpmPack(args) {
  // Windows: node refuses to spawn `npm.cmd` without a shell (CVE-2024-27980), and the
  // shell then re-splits arguments, so every argument has to be quoted back together.
  const isWindows = process.platform === "win32";
  const npmArguments = ["pack", "--ignore-scripts", "--json", ...args];
  const result = spawnSync(
    isWindows ? "npm.cmd" : "npm",
    isWindows ? npmArguments.map((argument) => `"${argument}"`) : npmArguments,
    { encoding: "utf8", shell: isWindows }
  );
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
    assert(
      header.subarray(257, 263).toString("ascii") === "ustar\0",
      "package tarball contains a non-ustar header"
    );

    // ustar fields are NUL-padded; everything before the first NUL is the value.
    const readString = (start, length) =>
      header.toString("utf8", start, start + length).split("\0")[0];
    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const readOctal = (start, length, field) => {
      const text = readString(start, length).trim();
      const value = text === "" ? 0 : Number.parseInt(text, 8);
      assert(Number.isSafeInteger(value), `invalid tar entry ${field} for ${entryPath}`);
      return value;
    };
    const mode = readOctal(100, 8, "mode");
    const size = readOctal(124, 12, "size");

    const dataOffset = offset + 512;
    entries.set(entryPath, { data: archive.subarray(dataOffset, dataOffset + size), mode });
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
  assert(Array.isArray(metadata.files), "npm pack dry-run files metadata is missing");
  const packedPaths = new Set(metadata.files.map((file) => file.path));
  for (const filePath of ["package.json", "LICENSE", "NOTICE.md", EXPECTED_EXECUTABLE_PATH]) {
    assert(packedPaths.has(filePath), `npm pack dry-run is missing ${filePath}`);
  }
}

function verifyTarball(tarballPath) {
  const entries = readTarEntries(tarballPath);
  const packageJson = JSON.parse(
    requiredEntry(entries, "package/package.json").data.toString("utf8")
  );
  const license = requiredEntry(entries, "package/LICENSE").data.toString("utf8");
  const notice = requiredEntry(entries, "package/NOTICE.md").data.toString("utf8");
  const executable = requiredEntry(entries, `package/${EXPECTED_EXECUTABLE_PATH}`);

  assert(packageJson.name === EXPECTED_PACKAGE_NAME, "tarball package name mismatch");
  assert(
    packageJson.bin?.[EXPECTED_EXECUTABLE_NAME] === EXPECTED_EXECUTABLE_PATH &&
      Object.keys(packageJson.bin).length === 1,
    "tarball executable mapping mismatch"
  );
  assert(
    executable.data.subarray(0, EXPECTED_NODE_SHEBANG.length).toString("utf8") ===
      EXPECTED_NODE_SHEBANG,
    "tarball executable entry is missing the Node.js shebang required by npm bin shims"
  );
  const executableProof =
    process.platform === "win32"
      ? "npm-bin-mapping-and-node-shebang"
      : "tar-executable-mode-and-node-shebang";
  // Windows npm shims use the exact bin mapping and Node shebang; POSIX launch also needs mode bits.
  if (process.platform !== "win32") {
    assert((executable.mode & 0o111) !== 0, "tarball executable entry is not executable");
  }
  assert(license.includes(UPSTREAM_COPYRIGHT), "tarball LICENSE lost the upstream copyright");
  assert(notice.includes(UPSTREAM_COPYRIGHT), "tarball NOTICE lost the upstream copyright");

  // Report what the tarball actually carried, not what we expected it to carry.
  return {
    packageName: packageJson.name,
    executablePath: packageJson.bin[EXPECTED_EXECUTABLE_NAME],
    executableMode: executable.mode,
    executableProof,
  };
}

function main() {
  const dryRun = runNpmPack(["--dry-run"]);
  verifyDryRunMetadata(dryRun);

  // The space is deliberate: it keeps the win32 argument quoting in runNpmPack exercised.
  const packDirectory = mkdtempSync(path.join(os.tmpdir(), "delegate claude pack-"));
  try {
    const packed = runNpmPack(["--pack-destination", packDirectory]);
    assert(packed.name === dryRun.name, "dry-run and tarball package names differ");
    const { packageName, executablePath, executableMode, executableProof } = verifyTarball(
      path.join(packDirectory, packed.filename)
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          package: packageName,
          executable: EXPECTED_EXECUTABLE_NAME,
          executablePath,
          executableMode,
          executableProof,
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
