const SIZE_TAG_RE = /^\[sz:(\d+),(\d+)\]/;

export interface ParsedSizeTag {
    width: number;
    height: number;
    cleaned: string;
}

export function extractSizeTag(content: string): ParsedSizeTag | null {
    const m = SIZE_TAG_RE.exec(content);
    if (!m) return null;
    const width = Number.parseInt(m[1], 10);
    const height = Number.parseInt(m[2], 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { width, height, cleaned: content.slice(m[0].length) };
}

export function cleanSizeTag(content: string): string {
    const m = SIZE_TAG_RE.exec(content);
    return m ? content.slice(m[0].length) : content;
}
