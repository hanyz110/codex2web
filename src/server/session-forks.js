function normalizedId(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function parseSessionForkMappings(payload) {
  const mappings = new Map();
  const forks = payload?.forks && typeof payload.forks === "object" ? payload.forks : {};
  for (const [sourceSessionId, record] of Object.entries(forks)) {
    const sourceId = normalizedId(sourceSessionId);
    const forkId = normalizedId(record?.forkSessionId);
    if (sourceId && forkId && sourceId !== forkId) {
      mappings.set(sourceId, forkId);
    }
  }
  return mappings;
}

export function resolveMappedSessionId(sessionId, mappings, availableSessionIds) {
  const sourceId = normalizedId(sessionId);
  if (!sourceId) {
    return "";
  }

  let currentId = sourceId;
  const visited = new Set([sourceId]);
  while (mappings.has(currentId)) {
    const nextId = normalizedId(mappings.get(currentId));
    if (!nextId || visited.has(nextId) || !availableSessionIds.has(nextId)) {
      break;
    }
    visited.add(nextId);
    currentId = nextId;
  }
  return currentId;
}

export function collectMappedForkSessionIds(mappings) {
  return new Set([...mappings.values()].map(normalizedId).filter(Boolean));
}

export function serializeSessionForkMappings(mappings) {
  const forks = {};
  for (const [sourceSessionId, forkSessionId] of mappings) {
    forks[sourceSessionId] = { forkSessionId };
  }
  return {
    forks,
    updatedAt: new Date().toISOString(),
    version: 1,
  };
}
