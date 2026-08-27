import path from "node:path";
import { realpath, stat } from "node:fs/promises";

export class FileDownloadError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.name = "FileDownloadError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isPathWithin(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function withoutSourceLocation(filePath) {
  return filePath.replace(/:\d+(?::\d+)?$/, "");
}

function downloadableCandidates(requestedPath) {
  const candidates = [requestedPath];
  const withoutLocation = withoutSourceLocation(requestedPath);
  if (withoutLocation !== requestedPath) {
    candidates.push(withoutLocation);
  }
  return candidates;
}

function mapFileSystemError(error) {
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
    return new FileDownloadError(404, "文件不存在或已被移动。", "DOWNLOAD_FILE_NOT_FOUND");
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return new FileDownloadError(403, "没有权限读取该文件。", "DOWNLOAD_FILE_FORBIDDEN");
  }
  return error;
}

export async function resolveDownloadFile({ projectPath, requestedPath }) {
  const normalizedProjectPath = String(projectPath || "").trim();
  const normalizedRequestedPath = String(requestedPath || "").trim();

  if (!normalizedProjectPath) {
    throw new FileDownloadError(409, "当前会话没有可用的项目目录。", "DOWNLOAD_PROJECT_UNAVAILABLE");
  }
  if (!normalizedRequestedPath || !path.isAbsolute(normalizedRequestedPath)) {
    throw new FileDownloadError(400, "下载路径必须是项目内的绝对文件路径。", "INVALID_DOWNLOAD_PATH");
  }

  let projectRealPath;
  try {
    projectRealPath = await realpath(normalizedProjectPath);
  } catch (error) {
    throw mapFileSystemError(error);
  }

  const projectInputPath = path.resolve(normalizedProjectPath);
  let lastNotFoundError = null;

  for (const candidate of downloadableCandidates(normalizedRequestedPath)) {
    const candidateInputPath = path.resolve(candidate);
    if (!isPathWithin(projectInputPath, candidateInputPath)) {
      throw new FileDownloadError(403, "只允许下载当前会话项目目录内的文件。", "DOWNLOAD_PATH_OUTSIDE_PROJECT");
    }

    let candidateRealPath;
    try {
      candidateRealPath = await realpath(candidateInputPath);
    } catch (error) {
      const mappedError = mapFileSystemError(error);
      if (mappedError instanceof FileDownloadError && mappedError.code === "DOWNLOAD_FILE_NOT_FOUND") {
        lastNotFoundError = mappedError;
        continue;
      }
      throw mappedError;
    }

    if (!isPathWithin(projectRealPath, candidateRealPath)) {
      throw new FileDownloadError(403, "文件通过符号链接指向了项目目录之外。", "DOWNLOAD_SYMLINK_OUTSIDE_PROJECT");
    }

    let fileInfo;
    try {
      fileInfo = await stat(candidateRealPath);
    } catch (error) {
      throw mapFileSystemError(error);
    }
    if (!fileInfo.isFile()) {
      throw new FileDownloadError(400, "下载目标必须是普通文件。", "DOWNLOAD_TARGET_NOT_FILE");
    }

    return {
      fileName: path.basename(candidateRealPath),
      filePath: candidateRealPath,
      modifiedAt: fileInfo.mtime,
      size: fileInfo.size,
    };
  }

  throw lastNotFoundError || new FileDownloadError(404, "文件不存在或已被移动。", "DOWNLOAD_FILE_NOT_FOUND");
}

function encodeRfc5987(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function buildDownloadHeaders(file) {
  const fallbackName = String(file.fileName || "download")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 180) || "download";
  const encodedName = encodeRfc5987(String(file.fileName || "download"));

  return {
    "cache-control": "private, no-cache, no-store, must-revalidate, max-age=0",
    "content-disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
    "content-length": String(file.size),
    "content-type": "application/octet-stream",
    expires: "0",
    "last-modified": file.modifiedAt.toUTCString(),
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    vary: "Authorization",
    "x-content-type-options": "nosniff",
  };
}
