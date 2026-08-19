import path from "node:path";

export const MAX_ATTACHMENT_COUNT = 10;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;

export const IMAGE_TYPES = new Map([
  ["image/gif", { ext: ".gif", magic: (buffer) => buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a" }],
  ["image/jpeg", { ext: ".jpg", magic: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff }],
  ["image/png", { ext: ".png", magic: (buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }],
  ["image/webp", { ext: ".webp", magic: (buffer) => buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP" }],
]);

export function sanitizeAttachmentName(value) {
  const basename = path.basename(typeof value === "string" ? value : "").trim();
  const normalized = basename.replace(/[\u0000-\u001f\u007f]/g, "_").replace(/[\\/:*?"<>|]/g, "_");
  return normalized.slice(0, 180) || "attachment";
}

export function isSupportedImageType(type) {
  return IMAGE_TYPES.has(String(type || "").toLowerCase());
}

export function decodeBase64Data(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Attachment data is required.");
  }

  const commaIndex = value.indexOf(",");
  const base64 = value.startsWith("data:") && commaIndex >= 0 ? value.slice(commaIndex + 1) : value;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new Error("Attachment data must be valid base64.");
  }

  return Buffer.from(base64, "base64");
}

export function buildAttachmentPrompt(prompt, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return prompt;
  }

  const lines = attachments.map((attachment) => {
    const name = sanitizeAttachmentName(attachment.name);
    const type = attachment.type || "application/octet-stream";
    return `- ${name} (${type})\n  本地文件路径：${attachment.path}`;
  });

  return `${prompt}\n\n[本次消息附件]\n请在需要时读取以下本地附件：\n${lines.join("\n")}`;
}
