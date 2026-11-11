import type { NuvioRawStream } from "../types.js";

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".m3u8",
  ".mpd",
  ".webm",
  ".avi",
  ".mov",
  ".flv",
  ".ts",
  ".m4v",
]);

const WEB_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".php",
  ".asp",
  ".aspx",
  ".jsp",
  ".cgi",
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".iso",
]);

const EMBED_PATH_PATTERNS = [
  /\/embed(?:\/|\?|$)/i,
  /\/e\/[a-zA-Z0-9_-]+/i,
  /\/v\/[a-zA-Z0-9_-]+/i,
  /\/iframe(?:\/|\?|$)/i,
  /\/player(?:\/|\?|$)/i,
  /\/watch(?:\/|\?|$)/i,
  /\/tg\/(?:go|bot)\b/i,
];

const KNOWN_EMBED_DOMAINS = [
  "moviesapi.to",
  "vidspark.to",
  "rubystm.com",
  "streamruby.net",
  "filesforever.link",
  "modiplay.xyz",
  "screenscape.me",
  "peachify.top",
  "nxsha.app",
  "nhdapi.com",
  "moviesnexus.fun",
  "vidrift.net",
  "vidout.pages.dev",
  "filmu.in",
  "vidbolt.xyz",
  "primesrc.",
  "xpass.",
  "vidrock.",
  "vaplayer.",
  "telegram.me",
  "t.me",
  "2embed.to",
  "2embed.cc",
  "autoembed.to",
  "multimovies.site",
  "superembed.stream",
  "player.smashystream.com",
  "streamwish.to",
  "vidlox.me",
  "doodstream.com",
  "dood.to",
  "dood.so",
  "mixdrop.co",
  "filelions.to",
  "streamtape.com",
];

export const BLOCKER_URL_PATTERN = /\/slowdown\b/i;

export function isWebPage(
  url: string,
  stream: Partial<NuvioRawStream> = {},
): boolean {
  if (typeof stream.externalUrl === "string" && stream.externalUrl.length > 0) {
    return true;
  }
  if (typeof url !== "string" || url.length === 0) return false;

  const server = typeof stream.server === "string" ? stream.server : "";
  const name = typeof stream.name === "string" ? stream.name : "";
  const title = typeof stream.title === "string" ? stream.title : "";
  const textHint = `${server} ${name} ${title}`;
  if (/\[embed\]|\bembed\b/i.test(textHint)) {
    const cleanUrl = url.split("#")[0]?.split("?")[0] ?? "";
    const hasVidExt = Array.from(VIDEO_EXTENSIONS).some((ext) =>
      cleanUrl.toLowerCase().endsWith(ext),
    );
    if (!hasVidExt) return true;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const pathname = parsed.pathname.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();

  for (const ext of VIDEO_EXTENSIONS) {
    if (pathname.endsWith(ext)) return false;
  }

  if (
    hostname.endsWith(".r2.cloudflarestorage.com") ||
    hostname === "video-downloads.googleusercontent.com" ||
    (hostname === "pixeldrain.com" && pathname.startsWith("/api/file/"))
  ) {
    return false;
  }

  for (const ext of WEB_EXTENSIONS) {
    if (pathname.endsWith(ext)) return true;
  }

  const fullPathAndQuery = `${pathname}${parsed.search}`;
  for (const pattern of EMBED_PATH_PATTERNS) {
    if (pattern.test(fullPathAndQuery)) return true;
  }

  for (const domain of KNOWN_EMBED_DOMAINS) {
    if (hostname.includes(domain)) return true;
  }

  return false;
}
