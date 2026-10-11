const URL_PATTERN = /https?:\/\/[^\s<>"'\]]+/gi;

function linkEnd(url: string): number {
  let depth = 0;
  for (let i = 0; i < url.length; i++) {
    if (url[i] === "(") depth += 1;
    else if (url[i] === ")" && --depth < 0) return i;
  }
  return url.length;
}

function findLinks(text: string): string[] {
  return (text.match(URL_PATTERN) ?? []).flatMap((match) => {
    const end = linkEnd(match);
    return [match.slice(0, end).replace(/[.,;:!?]+$/, ""), ...findLinks(match.slice(end))];
  });
}

export function extractLinksFromText(text: string): string[] {
  return [...new Set(findLinks(text))];
}

export function matchesSearchQuery(
  query: string,
  ...fields: Array<string | undefined | null>
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return fields.some((field) => field?.toLowerCase().includes(q));
}

export function snippetAroundMatch(text: string, query: string, maxLen = 120): string {
  const q = query.trim().toLowerCase();
  if (!q) return text.slice(0, maxLen);
  const lower = text.toLowerCase();
  const index = lower.indexOf(q);
  if (index < 0) return text.slice(0, maxLen);
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, start + maxLen);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

export type SearchThreadTarget =
  | { botId: string; groupId?: undefined }
  | { groupId: string; botId?: undefined };

export function searchHitThreadTarget(hit: {
  botId?: string;
  groupId?: string;
}): SearchThreadTarget {
  if (Boolean(hit.botId) === Boolean(hit.groupId)) {
    throw new Error("Search hit must target exactly one of a bot or group");
  }
  return hit.groupId ? { groupId: hit.groupId } : { botId: hit.botId! };
}
