const HEX = "0123456789abcdef";

const MIME_TO_EXT: Readonly<Record<string, string>> = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif",
    "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp", "image/svg+xml": "svg",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv",
    "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "audio/flac": "flac",
    "audio/mp4": "m4a", "audio/aac": "aac", "audio/opus": "opus",
    "application/pdf": "pdf", "application/zip": "zip", "application/gzip": "gz",
    "application/json": "json", "text/plain": "txt"
};

export function randomFor(originalName: string | null | undefined, mime: string | null | undefined): string {
    const b = crypto.getRandomValues(new Uint8Array(10));
    let hex = "";
    for (let i = 0; i < b.length; i++) {
        hex += HEX[(b[i] >> 4) & 0xf] + HEX[b[i] & 0xf];
    }
    let ext: string | null = null;
    if (mime) {
        const cleanMime = mime.toLowerCase().split(";")[0].trim();
        ext = MIME_TO_EXT[cleanMime] ?? null;
    }
    if (!ext && originalName) {
        const dot = originalName.lastIndexOf(".");
        if (dot >= 0) ext = originalName.slice(dot + 1);
    }
    if (ext != null) {
        ext = ext.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!ext || ext.length > 5) ext = null;
    }
    return ext ? `${hex}.${ext}` : hex;
}

export function addEncSuffix(original: string | null | undefined): string {
    if (!original) return "file.enc";
    const dot = original.lastIndexOf(".");
    if (dot > 0 && dot < original.length - 1) {
        return original.slice(0, dot) + ".enc" + original.slice(dot);
    }
    return original + ".enc";
}

export function isEncryptedFilename(name: string | null | undefined): boolean {
    return typeof name === "string" && (name.includes(".enc.") || name.endsWith(".enc"));
}
