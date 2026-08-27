import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSessionFileUrl,
  classifyMarkdownLinkTarget,
  replaceMarkdownLinks,
} from "../src/server/public/file-links.js";

test("classifies web and absolute local file links", () => {
  assert.deepEqual(classifyMarkdownLinkTarget("https://example.com/report.pdf"), {
    kind: "external",
    target: "https://example.com/report.pdf",
  });
  assert.deepEqual(classifyMarkdownLinkTarget("/project/report.pdf"), {
    kind: "local-file",
    target: "/project/report.pdf",
  });
});

test("supports angle-wrapped local paths containing spaces", () => {
  assert.deepEqual(classifyMarkdownLinkTarget("</project/季度 报表.xlsx>"), {
    kind: "local-file",
    target: "/project/季度 报表.xlsx",
  });
});

test("does not classify relative, protocol-relative, or script links", () => {
  for (const target of ["report.pdf", "//example.com/report.pdf", "javascript:alert(1)"]) {
    assert.equal(classifyMarkdownLinkTarget(target).kind, "unsupported");
  }
});

test("replaces Markdown links without restricting file extensions", () => {
  const source = [
    "[PDF](/project/report.pdf)",
    "[Excel](</project/季度 报表.xlsx>)",
    "[Word](/project/contract.docx)",
    "[PPT](/project/slides.pptx)",
  ].join(" ");
  const kinds = [];
  const replaced = replaceMarkdownLinks(source, (link) => {
    kinds.push(link.kind);
    return `<${link.target}>`;
  });

  assert.deepEqual(kinds, ["local-file", "local-file", "local-file", "local-file"]);
  assert.match(replaced, /<\/project\/report\.pdf>/);
  assert.match(replaced, /<\/project\/季度 报表\.xlsx>/);
});

test("builds a client-bound URL with encoded path parameters", () => {
  const url = buildSessionFileUrl("/project/季度 报表.xlsx", "client 123");
  const parsed = new URL(url, "http://localhost");
  assert.equal(parsed.pathname, "/api/session/file");
  assert.equal(parsed.searchParams.get("path"), "/project/季度 报表.xlsx");
  assert.equal(parsed.searchParams.get("clientId"), "client 123");
});
