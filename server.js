// Pin Saver — zero-dependency Node server (Node 18+)
// Run: node server.js   →   http://localhost:3000

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

const PORT = process.env.PORT || 3000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---------- helpers ----------
const isPinterestUrl = (u) => {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return /(^|\.)pinterest\.[a-z.]+$/.test(h) || h === "pin.it";
  } catch {
    return false;
  }
};

const isPinimgUrl = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && /(^|\.)pinimg\.com$/.test(x.hostname);
  } catch {
    return false;
  }
};

const unescapeJson = (s) =>
  s.replace(/\\u002F/gi, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&");

// Upgrade any pinimg image URL (236x, 564x, 736x...) to the original file
const toOriginal = (url) => url.replace(/i\.pinimg\.com\/[^/]+\//, "i.pinimg.com/originals/");

async function fetchPage(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!res.ok) throw new Error(`Pinterest returned ${res.status}`);
  return { html: await res.text(), finalUrl: res.url };
}

function extractMedia(html) {
  const text = unescapeJson(html);
  const images = new Set();
  const videos = new Map(); // url -> label
  let hls = null;
  let title = "";

  const t = html.match(/<meta property="og:title" content="([^"]*)"/i);
  if (t) title = t[1];

  // Videos: direct MP4s hosted on pinimg
  const mp4 = text.match(/https:\/\/v\d*\.pinimg\.com\/videos\/[^"'\\\s]+?\.mp4/g) || [];
  for (const u of new Set(mp4)) {
    const q = u.match(/_(\d{3,4})w?p?\.mp4|720w|\/(\d{3,4})p\//);
    videos.set(u, q ? q[0] : "mp4");
  }
  const m3u8 = text.match(/https:\/\/v\d*\.pinimg\.com\/videos\/[^"'\\\s]+?\.m3u8/g);
  if (m3u8) hls = m3u8[0];

  // Images: prefer "originals", otherwise upgrade whatever size we find
  const imgs = text.match(/https:\/\/i\.pinimg\.com\/(?:originals|\d+x)\/[^"'\\\s]+?\.(?:jpg|jpeg|png|webp|gif)/gi) || [];
  for (const u of imgs) images.add(toOriginal(u));

  const og = html.match(/<meta property="og:image" content="([^"]+)"/i);
  if (og && isPinimgUrl(og[1])) images.add(toOriginal(og[1]));

  const hasVideo = videos.size > 0 || hls;

  // If it's a video pin, the image list is just the poster/thumbnail — keep only the first.
  // For image pins, the first match is the pin itself; "more like this" thumbnails follow.
  const imageList = [...images].slice(0, hasVideo ? 1 : 1);

  // Rank videos: biggest resolution number first
  const videoList = [...videos.keys()].sort((a, b) => {
    const n = (s) => Number((s.match(/(\d{3,4})(?=[^\d]*\.mp4)/) || [0, 0])[1]);
    return n(b) - n(a);
  });

  return { title, images: imageList, videos: videoList.slice(0, 3), hls };
}

// ---------- routes ----------
async function handleResolve(reqUrl, res) {
  const target = reqUrl.searchParams.get("url") || "";
  if (!isPinterestUrl(target)) return json(res, 400, { error: "Paste a Pinterest pin link (pinterest.com/pin/… or pin.it/…)." });

  try {
    const { html, finalUrl } = await fetchPage(target);
    if (!isPinterestUrl(finalUrl)) return json(res, 400, { error: "That link doesn't lead to Pinterest." });
    const media = extractMedia(html);
    if (!media.images.length && !media.videos.length)
      return json(res, 404, { error: "No media found. The pin may be private, removed, or Pinterest changed its page layout." });
    json(res, 200, media);
  } catch (e) {
    json(res, 502, { error: `Couldn't load the pin: ${e.message}` });
  }
}

async function handleDownload(reqUrl, res) {
  const file = reqUrl.searchParams.get("file") || "";
  const name = (reqUrl.searchParams.get("name") || "pin").replace(/[^\w.-]+/g, "_").slice(0, 80);
  if (!isPinimgUrl(file)) return json(res, 400, { error: "Only Pinterest media can be downloaded." });

  try {
    const upstream = await fetch(file, { headers: { "User-Agent": UA, Referer: "https://www.pinterest.com/" } });
    if (!upstream.ok) return json(res, 502, { error: `Source returned ${upstream.status}` });
    const ext = (file.match(/\.(\w{3,4})(?:\?|$)/) || [, "bin"])[1];
    res.writeHead(200, {
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}.${ext}"`,
      ...(upstream.headers.get("content-length") && { "Content-Length": upstream.headers.get("content-length") }),
    });
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    json(res, 502, { error: e.message });
  }
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---------- server ----------
http
  .createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === "/api/resolve") return handleResolve(u, res);
    if (u.pathname === "/api/download") return handleDownload(u, res);
    const html = fs.readFileSync(path.join(__dirname, "public", "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  })
  .listen(PORT, () => console.log(`Pin Saver running → http://localhost:${PORT}`));
