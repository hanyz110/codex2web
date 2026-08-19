import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAttachmentPrompt,
  decodeBase64Data,
  sanitizeAttachmentName,
} from "../src/server/attachments.js";

test("attachment names are reduced to safe basenames", () => {
  assert.equal(sanitizeAttachmentName("../../private/report:2026?.md"), "report_2026_.md");
  assert.equal(sanitizeAttachmentName(""), "attachment");
});

test("attachment data decodes both raw and data-url base64", () => {
  assert.deepEqual(decodeBase64Data("aGVsbG8="), Buffer.from("hello"));
  assert.deepEqual(decodeBase64Data("data:text/plain;base64,aGVsbG8="), Buffer.from("hello"));
  assert.throws(() => decodeBase64Data("not base64"), /valid base64/);
});

test("attachment prompt keeps the original request and local paths", () => {
  const result = buildAttachmentPrompt("请总结附件", [
    { name: "notes.txt", path: "/tmp/notes.txt", type: "text/plain" },
  ]);

  assert.match(result, /^请总结附件/);
  assert.match(result, /notes\.txt \(text\/plain\)/);
  assert.match(result, /本地文件路径：\/tmp\/notes\.txt/);
});
