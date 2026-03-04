export function sanitizeFilename(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "file";
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function wrapText(value: string, lineWidth: number): string {
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
      continue;
    }

    if (`${currentLine} ${word}`.length <= lineWidth) {
      currentLine = `${currentLine} ${word}`;
      continue;
    }

    lines.push(currentLine);
    currentLine = word;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.join("\n");
}

export function normalizeHashtag(value: string): string {
  const cleaned = value.replace(/\s+/g, "").replace(/^#+/, "").toLowerCase();
  return cleaned ? `#${cleaned}` : "";
}

export function slugifyId(prefix: string, value: string): string {
  return `${prefix}-${sanitizeFilename(value)}`;
}
