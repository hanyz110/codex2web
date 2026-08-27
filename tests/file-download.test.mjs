import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { buildDownloadHeaders, resolveDownloadFile } from "../src/server/file-download.js";

let outsideDir;
let projectDir;
let tempRoot;

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex2web-download-"));
  projectDir = path.join(tempRoot, "project");
  outsideDir = path.join(tempRoot, "outside");
  await mkdir(projectDir);
  await mkdir(outsideDir);
});

after(async () => {
  await rm(tempRoot, { force: true, recursive: true });
});

test("resolves regular files of common document types", async () => {
  for (const fileName of ["report.pdf", "budget.xlsx", "contract.docx", "slides.pptx", "notes.md"]) {
    const filePath = path.join(projectDir, fileName);
    await writeFile(filePath, fileName);
    const file = await resolveDownloadFile({ projectPath: projectDir, requestedPath: filePath });
    assert.equal(file.fileName, fileName);
    assert.equal(file.filePath, await realpath(filePath));
    assert.equal(file.size, Buffer.byteLength(fileName));
  }
});

test("preserves Chinese and spaced filenames in download headers", async () => {
  const filePath = path.join(projectDir, "季度 报表.xlsx");
  await writeFile(filePath, "sheet");
  const file = await resolveDownloadFile({ projectPath: projectDir, requestedPath: filePath });
  const headers = buildDownloadHeaders(file);

  assert.equal(headers["content-type"], "application/octet-stream");
  assert.equal(headers["content-length"], "5");
  assert.match(headers["content-disposition"], /attachment;/);
  assert.match(headers["content-disposition"], /filename\*=UTF-8''%E5%AD%A3%E5%BA%A6%20%E6%8A%A5%E8%A1%A8\.xlsx/);
});

test("rejects missing and relative paths", async () => {
  await assert.rejects(
    resolveDownloadFile({ projectPath: projectDir, requestedPath: path.join(projectDir, "missing.pdf") }),
    (error) => error.statusCode === 404 && error.code === "DOWNLOAD_FILE_NOT_FOUND",
  );
  await assert.rejects(
    resolveDownloadFile({ projectPath: projectDir, requestedPath: "report.pdf" }),
    (error) => error.statusCode === 400 && error.code === "INVALID_DOWNLOAD_PATH",
  );
});

test("rejects files outside the current project", async () => {
  const outsideFile = path.join(outsideDir, "private.pdf");
  await writeFile(outsideFile, "private");
  await assert.rejects(
    resolveDownloadFile({ projectPath: projectDir, requestedPath: outsideFile }),
    (error) => error.statusCode === 403 && error.code === "DOWNLOAD_PATH_OUTSIDE_PROJECT",
  );
});

test("rejects symlinks that escape the current project", async () => {
  const outsideFile = path.join(outsideDir, "secret.docx");
  const linkedFile = path.join(projectDir, "linked.docx");
  await writeFile(outsideFile, "secret");
  await symlink(outsideFile, linkedFile);
  await assert.rejects(
    resolveDownloadFile({ projectPath: projectDir, requestedPath: linkedFile }),
    (error) => error.statusCode === 403 && error.code === "DOWNLOAD_SYMLINK_OUTSIDE_PROJECT",
  );
});

test("rejects directories", async () => {
  const directoryPath = path.join(projectDir, "folder");
  await mkdir(directoryPath);
  await assert.rejects(
    resolveDownloadFile({ projectPath: projectDir, requestedPath: directoryPath }),
    (error) => error.statusCode === 400 && error.code === "DOWNLOAD_TARGET_NOT_FILE",
  );
});

test("accepts Codex source location suffixes", async () => {
  const filePath = path.join(projectDir, "source.txt");
  await writeFile(filePath, "source");
  const file = await resolveDownloadFile({ projectPath: projectDir, requestedPath: `${filePath}:12:4` });
  assert.equal(file.filePath, await realpath(filePath));
});
