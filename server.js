// Media Saver v2 — Pinterest + YouTube / Facebook / Instagram / X (via yt-dlp)
// Needs: Node 18+, yt-dlp, ffmpeg
// Run: node server.js  →  http://localhost:3000

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { Readable } = require("stream");

const PORT = process.env.PORT || 3000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const COOKIES = path.join(__dirname, "cookies.txt"); // optional, for private/login-only posts
const QUALITIES = ["best", "2160", "1440", "1080", "720", "480", "360", "audio"];
const MAX_JOBS = 2;
let activeJobs = 0;

// ---------- url checks ----------
const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
};
const isPinterestUrl = (u) => {
  const h = hostOf(u);
  return /(^|\.)pinterest\.[a-z.]+$/.test(h) || h === "pin.it";
};
const isYtdlpUrl = (u) =>
  /(^|\.)(youtube\.com|youtu\.be|facebook\.com|fb\.watch|fb\.com|instagram\.com|twitter\.com|x\.com|t\.co)$/.test(hostOf(u));
const isPinimgUrl = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && /(^|\.)pinimg\.com$/.test(x.hostname);
  } catch {
    return false;
  }
};

// ---------- Pinterest ----------
const unescapeJson = (s) => s.replace(/\\u002F/gi, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&");
const toOriginal = (url) => url.replace(/i\.pinimg\.com\/[^/]+\//, "i.pinimg.com/originals/");

async function fetchPage(url) {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } });
  if (!res.ok) throw new Error(`Pinterest returned ${res.status}`);
  return { html: await res.text(), finalUrl: res.url };
}

function extractPinterest(html) {
  const text = unescapeJson(html);
  const images = new Set();
  const videos = new Set();
  let title = "";
  const t = html.match(/<meta property="og:title" content="([^"]*)"/i);
  if (t) title = t[1];

  for (const u of text.match(/https:\/\/v\d*\.pinimg\.com\/videos\/[^"'\\\s]+?\.mp4/g) || []) videos.add(u);
  for (const u of text.match(/https:\/\/i\.pinimg\.com\/(?:originals|\d+x)\/[^"'\\\s]+?\.(?:jpg|jpeg|png|webp|gif)/gi) || [])
    images.add(toOriginal(u));
  const og = html.match(/<meta property="og:image" content="([^"]+)"/i);
  if (og && isPinimgUrl(og[1])) images.add(toOriginal(og[1]));

  const n = (s) => Number((s.match(/(\d{3,4})(?=[^\d]*\.mp4)/) || [0, 0])[1]);
  const videoList = [...videos].sort((a, b) => n(b) - n(a));
  return { kind: "pinterest", title, images: [...images].slice(0, 1), videos: videoList.slice(0, 3) };
}

async function resolvePinterest(target) {
  const { html, finalUrl } = await fetchPage(target);
  if (!isPinterestUrl(finalUrl)) throw Object.assign(new Error("That link doesn't lead to Pinterest."), { code: 400 });
  const media = extractPinterest(html);
  if (!media.images.length && !media.videos.length)
    throw Object.assign(new Error("No media found. The pin may be private, removed, or Pinterest changed its layout."), { code: 404 });
  return media;
}

// ---------- yt-dlp ----------
const baseArgs = () => ["--no-playlist", "--no-warnings", ...(fs.existsSync(COOKIES) ? ["--cookies", COOKIES] : [])];

const ytdlpError = (err, stderr) => {
  if (err && err.code === "ENOENT")
    return "yt-dlp is not installed. In Termux run: pip install -U yt-dlp (and pkg install ffmpeg).";
  const lines = String(stderr || err.message || "").trim().split("\n");
  const last = lines.filter((l) => /ERROR/i.test(l)).pop() || lines.pop() || "Unknown error";
  return last.replace(/^ERROR:\s*/i, "").slice(0, 300);
};

function resolveYtdlp(target) {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      [...baseArgs(), "-J", "--", target],
      { maxBuffer: 64 * 1024 * 1024, timeout: 90000 },
      (err, stdout, stderr) => {
        if (err) return reject(Object.assign(new Error(ytdlpError(err, stderr)), { code: 502 }));
        try {
          const info = JSON.parse(stdout);
          const heights = [...new Set((info.formats || []).map((f) => f.height).filter(Boolean))].sort((a, b) => b - a);
          resolve({
            kind: "ytdlp",
            title: info.title || "video",
            thumbnail: info.thumbnail || "",
            duration: info.duration || 0,
            uploader: info.uploader || "",
            heights,
          });
        } catch {
          reject(Object.assign(new Error("Couldn't read video info."), { code: 502 }));
        }
      }
    );
  });
}

const cleanName = (s) => (String(s || "").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "video");
const MIME = { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mp3: "audio/mpeg", m4a: "audio/mp4", jpg: "image/jpeg" };

function handleYtdl(u, req, res) {
  const target = u.searchParams.get("url") || "";
  const q = u.searchParams.get("q") || "best";
  const name = cleanName(u.searchParams.get("name"));
  if (!isYtdlpUrl(target)) return json(res, 400, { error: "Unsupported link." });
  if (!QUALITIES.includes(q)) return json(res, 400, { error: "Bad quality option." });
  if (activeJobs >= MAX_JOBS) return json(res, 429, { error: "Server is busy. Try again in a minute." });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-"));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });

  const fmt =
    q === "audio"
      ? ["-x", "--audio-format", "mp3", "--audio-quality", "0"]
      : q === "best"
      ? ["-f", "bv*+ba/b", "--merge-output-format", "mp4"]
      : ["-f", `bv*[height<=${q}]+ba/b[height<=${q}]/b`, "--merge-output-format", "mp4"];

  activeJobs++;
  const child = spawn("yt-dlp", [...baseArgs(), ...fmt, "-o", path.join(dir, "out.%(ext)s"), "--", target]);
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  res.on("close", () => {
    if (child.exitCode === null) child.kill();
  });

  child.on("error", (err) => {
    activeJobs--;
    cleanup();
    json(res, 502, { error: ytdlpError(err, stderr) });
  });

  child.on("close", (code) => {
    activeJobs--;
    const file = fs.readdirSync(dir).find((f) => !f.endsWith(".part") && !f.endsWith(".ytdl"));
    if (code !== 0 || !file) {
      cleanup();
      if (!res.headersSent) json(res, 502, { error: ytdlpError(null, stderr) });
      return;
    }
    const full = path.join(dir, file);
    const ext = path.extname(file).slice(1).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": fs.statSync(full).size,
      "Content-Disposition": `attachment; filename="${name}.${ext}"`,
    });
    const stream = fs.createReadStream(full);
    stream.pipe(res);
    res.on("close", cleanup);
  });
}

// ---------- YouTube channel / playlist listing + batch save ----------
const MAX_LIST = 1000;
const SAVE_DIR =
  process.env.SAVE_DIR ||
  (() => {
    const dl = path.join(os.homedir(), "storage", "downloads");
    return path.join(fs.existsSync(dl) ? dl : __dirname, "MediaSaver");
  })();

const isYoutubeUrl = (u) => /(^|\.)(youtube\.com|youtu\.be)$/.test(hostOf(u));
const cookieArgs = () => (fs.existsSync(COOKIES) ? ["--cookies", COOKIES] : []);

function fmtArgs(q) {
  if (q === "audio") return ["-x", "--audio-format", "mp3", "--audio-quality", "0"];
  if (q === "best") return ["-f", "bv*+ba/b", "--merge-output-format", "mp4"];
  return ["-f", `bv*[height<=${q}]+ba/b[height<=${q}]/b`, "--merge-output-format", "mp4"];
}

function listTarget(raw, tab) {
  const u = new URL(raw);
  const p = u.pathname.replace(/\/+$/, "");
  const list = u.searchParams.get("list");
  if (p === "/playlist" && list && /^[\w-]+$/.test(list))
    return { url: `https://www.youtube.com/playlist?list=${list}`, tab: "playlist" };
  const m = p.match(/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/);
  if (m) {
    const t = tab === "shorts" ? "shorts" : "videos";
    return { url: `https://www.youtube.com${m[0]}/${t}`, tab: t };
  }
  return null;
}

function handleList(u, res) {
  const raw = (u.searchParams.get("url") || "").trim();
  if (!isYoutubeUrl(raw)) return json(res, 400, { error: "Paste a YouTube channel or playlist link." });
  const t = listTarget(raw, u.searchParams.get("tab"));
  if (!t)
    return json(res, 400, {
      error: "That looks like a single video. Paste a channel link (youtube.com/@name) or a playlist link.",
    });

  execFile(
    "yt-dlp",
    ["--flat-playlist", "-J", "--no-warnings", "--playlist-end", String(MAX_LIST), ...cookieArgs(), "--", t.url],
    { maxBuffer: 128 * 1024 * 1024, timeout: 180000 },
    (err, stdout, stderr) => {
      if (err) return json(res, 502, { error: ytdlpError(err, stderr) });
      try {
        const info = JSON.parse(stdout);
        const flat = (arr) => arr.flatMap((e) => (e && e.entries ? flat(e.entries) : [e]));
        const entries = flat(info.entries || [])
          .filter((e) => e && /^[\w-]{11}$/.test(e.id || ""))
          .map((e) => ({
            id: e.id,
            title: e.title || e.id,
            duration: e.duration || 0,
            thumb: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
          }));
        json(res, 200, {
          title: info.title || info.uploader || "YouTube",
          tab: t.tab,
          count: entries.length,
          capped: entries.length >= MAX_LIST,
          saveDir: SAVE_DIR,
          entries,
        });
      } catch {
        json(res, 502, { error: "Couldn't read the video list." });
      }
    }
  );
}

const jobs = new Map();
let batchRunning = false;

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleBatchStart(req, res) {
  if (batchRunning) return json(res, 429, { error: "A batch is already running. Wait for it or cancel it." });
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "Bad request." });
  }
  const ids = [...new Set(body.ids || [])].filter((id) => /^[\w-]{11}$/.test(id)).slice(0, MAX_LIST);
  const q = QUALITIES.includes(body.q) ? body.q : "best";
  if (!ids.length) return json(res, 400, { error: "Select at least one video." });

  const id = Date.now().toString(36);
  const job = { id, total: ids.length, done: 0, failed: 0, current: "", status: "running", errors: [], saveDir: SAVE_DIR, cancelled: false, child: null };
  jobs.set(id, job);
  batchRunning = true;
  runBatch(job, ids, q);
  json(res, 200, { id, saveDir: SAVE_DIR });
}

async function runBatch(job, ids, q) {
  try {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
  } catch (e) {
    job.status = "finished";
    job.failed = job.total;
    job.errors.push("Can't create save folder: " + e.message);
    batchRunning = false;
    return;
  }
  for (const vid of ids) {
    if (job.cancelled) break;
    job.current = vid;
    const result = await new Promise((resolve) => {
      const child = spawn("yt-dlp", [
        ...baseArgs(),
        ...fmtArgs(q),
        "--no-overwrites",
        "--windows-filenames",
        "--sleep-interval", "1",
        "--max-sleep-interval", "4",
        "--no-simulate",
        "--print", "before_dl:%(title)s",
        "-o", path.join(SAVE_DIR, "%(title).80s [%(id)s].%(ext)s"),
        "--",
        `https://www.youtube.com/watch?v=${vid}`,
      ]);
      job.child = child;
      let err = "";
      child.stdout.on("data", (d) => {
        const line = String(d).trim().split("\n")[0];
        if (line) job.current = line.slice(0, 100);
      });
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => resolve({ ok: false, msg: ytdlpError(e, err) }));
      child.on("close", (code) => resolve({ ok: code === 0, msg: ytdlpError(null, err) }));
    });
    if (result.ok) job.done++;
    else if (!job.cancelled) {
      job.failed++;
      job.errors.push(`${vid}: ${result.msg}`);
      if (job.errors.length > 5) job.errors.shift();
    }
  }
  job.child = null;
  job.current = "";
  job.status = job.cancelled ? "cancelled" : "finished";
  batchRunning = false;
}

function handleBatchStatus(u, res) {
  const job = jobs.get(u.searchParams.get("id"));
  if (!job) return json(res, 404, { error: "Batch not found (the server may have restarted)." });
  const { child, ...pub } = job;
  json(res, 200, pub);
}

function handleBatchCancel(u, res) {
  const job = jobs.get(u.searchParams.get("id"));
  if (!job) return json(res, 404, { error: "Batch not found." });
  job.cancelled = true;
  if (job.child) job.child.kill();
  json(res, 200, { ok: true });
}

// ---------- routes ----------
async function handleResolve(u, res) {
  const target = (u.searchParams.get("url") || "").trim();
  try {
    if (isPinterestUrl(target)) return json(res, 200, await resolvePinterest(target));
    if (isYtdlpUrl(target)) return json(res, 200, await resolveYtdlp(target));
    json(res, 400, { error: "Unsupported link. Use Pinterest, YouTube, Facebook, Instagram or X." });
  } catch (e) {
    json(res, e.code || 502, { error: e.message });
  }
}

async function handlePinDownload(u, res) {
  const file = u.searchParams.get("file") || "";
  const name = cleanName(u.searchParams.get("name") || "pin");
  if (!isPinimgUrl(file)) return json(res, 400, { error: "Only Pinterest media can be downloaded here." });
  try {
    const up = await fetch(file, { headers: { "User-Agent": UA, Referer: "https://www.pinterest.com/" } });
    if (!up.ok) return json(res, 502, { error: `Source returned ${up.status}` });
    const ext = (file.match(/\.(\w{3,4})(?:\?|$)/) || [, "bin"])[1];
    res.writeHead(200, {
      "Content-Type": up.headers.get("content-type") || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}.${ext}"`,
      ...(up.headers.get("content-length") && { "Content-Length": up.headers.get("content-length") }),
    });
    Readable.fromWeb(up.body).pipe(res);
  } catch (e) {
    json(res, 502, { error: e.message });
  }
}

function json(res, code, body) {
  if (res.headersSent) return;
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === "/api/resolve") return handleResolve(u, res);
    if (u.pathname === "/api/download") return handlePinDownload(u, res);
    if (u.pathname === "/api/ytdl") return handleYtdl(u, req, res);
    if (u.pathname === "/api/list") return handleList(u, res);
    if (u.pathname === "/api/batch" && req.method === "POST") return handleBatchStart(req, res);
    if (u.pathname === "/api/batch/status") return handleBatchStatus(u, res);
    if (u.pathname === "/api/batch/cancel") return handleBatchCancel(u, res);
    const html = fs.readFileSync(path.join(__dirname, "public", "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  })
  .listen(PORT, () => console.log(`Media Saver running → http://localhost:${PORT}`));
