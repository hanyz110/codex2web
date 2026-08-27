const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)/g;

export function normalizeMarkdownLinkTarget(rawTarget) {
  const trimmed = String(rawTarget || "").trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function classifyMarkdownLinkTarget(rawTarget) {
  const target = normalizeMarkdownLinkTarget(rawTarget);
  if (/^https?:\/\//i.test(target)) {
    return { kind: "external", target };
  }
  if (target.startsWith("/") && !target.startsWith("//")) {
    return { kind: "local-file", target };
  }
  return { kind: "unsupported", target };
}

export function replaceMarkdownLinks(text, replacer) {
  return String(text || "").replace(MARKDOWN_LINK_PATTERN, (match, label, rawTarget) => {
    const link = classifyMarkdownLinkTarget(rawTarget);
    return replacer({ ...link, label, match, rawTarget });
  });
}

export function buildSessionFileUrl(filePath, clientId) {
  const params = new URLSearchParams({
    clientId: String(clientId || ""),
    path: String(filePath || ""),
  });
  return `/api/session/file?${params.toString()}`;
}
