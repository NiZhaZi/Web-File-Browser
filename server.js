import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import crypto from "crypto";
import { spawn } from "child_process"; // 添加这行导入
import zlib from "zlib";
// import users from "./users.json" assert { type: "json" };
const users = JSON.parse(fs.readFileSync("./users.json", "utf-8"));

// === Load external JSON config (URL/PORT/ROOTS/OpenSubtitles) ===
const CONFIG_PATH = "./config.json";
let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  console.log("[config] loaded from", CONFIG_PATH);
} catch (e) {
  console.warn("[config] config.json not found, using built-in defaults");
  CONFIG = {};
}

const LRCLIB_BASE = "https://lrclib.net/api";

const app = express();
const URL = (CONFIG.server && CONFIG.server.url) || "localhost";
const PORT = (CONFIG.server && CONFIG.server.port) || 3000;

// 媒体库配置（请改成你实际的路径）
const ROOTS_DEFAULT = {
  movies: "D:/media/movies",
  music: "D:/media/music",
  photos: "D:/media/photos",
  documents: "D:/media/documents",
  downloads: "D:/media/downloads"
};
// Prefer roots from config.json if provided
const ROOTS = (CONFIG.roots && Object.keys(CONFIG.roots).length ? CONFIG.roots : ROOTS_DEFAULT);


// 会话存储 (token -> username)
const sessions = {};

app.use(cors());
app.use(express.json());
app.use(express.static(".")); // 提供 index.html


const OS_CFG = {
  API_KEY: (CONFIG.opensubtitles && CONFIG.opensubtitles.apiKey) || process.env.OS_API_KEY || "",
  USERNAME: (CONFIG.opensubtitles && CONFIG.opensubtitles.username) || process.env.OS_USERNAME || "",
  PASSWORD: (CONFIG.opensubtitles && CONFIG.opensubtitles.password) || process.env.OS_PASSWORD || "",
  USER_AGENT: (CONFIG.opensubtitles && CONFIG.opensubtitles.userAgent) || process.env.OS_USERAGENT || "MyPlayer/1.0"
};


let OS_STATE = {
  baseUrl: "https://api.opensubtitles.com/api/v1",
  token: null,          // 用户 JWT
  tokenExpires: 0       // 仅作缓存控制，简单起见可不严格校验过期
};

function composeLRCFromLrclib(json) {
  if (!json) return "";
  if (json.syncedLyrics && json.syncedLyrics.trim()) return json.syncedLyrics;
  if (json.plainLyrics && json.plainLyrics.trim()) {
    return json.plainLyrics.split(/\r?\n/).map(s => s.trim()).join('\n');
  }
  return "";
}

// --- OpenSubtitles helpers ---
// const _fetch = globalThis.fetch; // require Node 18+. If undefined, install node-fetch and import.

async function osFetch(pathname, { method = "GET", headers = {}, json, rawBody } = {}) {
  if (!_fetch) throw new Error("当前 Node 版本缺少 fetch；请使用 Node 18+ 或引入 node-fetch。");
  if (!OS_CFG.API_KEY) throw new Error("缺少 OpenSubtitles API Key。请在 config.json.opensubtitles.apiKey 配置。");
  const h = {
    "Api-Key": OS_CFG.API_KEY,
    "Accept": "application/json",
    ...headers
  };
  if (OS_STATE.token) h["Authorization"] = `Bearer ${OS_STATE.token}`;
  let body;
  if (json) { h["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  if (rawBody) { body = rawBody; }
  const url = `${OS_STATE.baseUrl}${pathname}`;
  const r = await _fetch(url, { method, headers: h, body });
  if (!r.ok) {
    const txt = await r.text().catch(()=> "");
    throw new Error(`OS API ${method} ${pathname} ${r.status} ${r.statusText} ${txt}`);
  }
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? r.json() : r.arrayBuffer();
}

async function osLogin(username, password) {
  username = username || OS_CFG.USERNAME;
  password = password || OS_CFG.PASSWORD;
  if (!username || !password) throw new Error("缺少 OpenSubtitles 用户名或密码");
  const data = await osFetch("/login", {
    method: "POST",
    json: { username, password, remember_me: true, user_agent: OS_CFG.USER_AGENT }
  });
  OS_STATE.token = data.token;
  if (data.base_url) OS_STATE.baseUrl = data.base_url;
  OS_STATE.tokenExpires = Date.now() + 6*60*60*1000;
  return { baseUrl: OS_STATE.baseUrl };
}

function computeOSHash(filePath) {
  const stat = fs.statSync(filePath);
  const size = BigInt(stat.size);
  const chunk = 64 * 1024;
  const buf = Buffer.alloc(chunk);
  const fd = fs.openSync(filePath, "r");
  let hash = size;
  // head
  let bytes = fs.readSync(fd, buf, 0, chunk, 0);
  for (let i = 0; i + 8 <= bytes; i += 8) hash += buf.readBigUInt64LE(i);
  // tail
  const tailStart = Math.max(0, stat.size - chunk);
  bytes = fs.readSync(fd, buf, 0, chunk, tailStart);
  for (let i = 0; i + 8 <= bytes; i += 8) hash += buf.readBigUInt64LE(i);
  fs.closeSync(fd);
  return hash.toString(16).padStart(16, "0");
}

async function ensureOsLogin() {
  const stillValid = OS_STATE.token && (Date.now() < (OS_STATE.tokenExpires || 0) - 60*1000);
  if (stillValid) return true;
  if (OS_CFG.API_KEY && (OS_CFG.USERNAME && OS_CFG.PASSWORD)) {
    try {
      await osLogin(OS_CFG.USERNAME, OS_CFG.PASSWORD);
      console.log("[OpenSubtitles] 登录成功");
      return true;
    } catch (e) {
      console.warn("[OpenSubtitles] 自动登录失败：", e.message);
      return false;
    }
  }
  return false;
}

// 尝试在启动时自动登录（如果配置了账号密码）
ensureOsLogin();


// Node18+ 自带 fetch；老版本可 npm i node-fetch 并在此按需导入
const _fetch = globalThis.fetch || (await import('node-fetch')).default;

// 登录接口
app.post("/api/login", (req, res) => {
  try {
      const { username, password } = req.body;

      if (!username || !password) {
          return res.status(400).json({ 
              success: false, 
              error: "用户名和密码不能为空" 
          });
      }

      const user = users.find(
          (u) => u.username === username && u.password === password
      );

      if (!user) {
          return res.status(401).json({ 
              success: false, 
              error: "用户名或密码错误" 
          });
      }

      // 生成随机 token
      const token = crypto.randomBytes(16).toString("hex");
      sessions[token] = username;

      res.json({ success: true, token });
  } catch (error) {
      console.error("登录处理错误:", error);
      res.status(500).json({ 
          success: false, 
          error: "服务器内部错误" 
      });
  }
});

// 认证中间件
function authMiddleware(req, res, next) {
  const token = req.headers["authorization"];
  if (!token || !sessions[token]) {
    return res
      .status(401)
      .json({ success: false, error: "未登录或会话失效" });
  }
  req.user = sessions[token];
  next();
}

// 获取文件列表
app.get("/api/files", authMiddleware, (req, res) => {
  const { folder, path: subPath = "" } = req.query;
  const root = ROOTS[folder];
  if (!root) return res.json({ success: false, error: "无效的文件夹" });

  const dirPath = path.join(root, subPath);
  try {
    const files = fs.readdirSync(dirPath).map((name) => {
      const fullPath = path.join(dirPath, name);
      const stat = fs.statSync(fullPath);
      return {
        name,
        isDirectory: stat.isDirectory(),
        size: stat.size,
      };
    });
    res.json({ success: true, files });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 文件流接口 - 支持token参数认证
app.get("/api/stream", (req, res) => {
  // 尝试从查询参数或头部获取token
  let token = req.query.token || req.headers["authorization"];
  
  if (!token || !sessions[token]) {
    return res.status(401).json({ 
      success: false, 
      error: "未登录或会话失效" 
    });
  }
  
  const { folder, path: subPath = "" } = req.query;
  const root = ROOTS[folder];
  
  if (!root) {
    return res.status(400).json({ 
      success: false, 
      error: "无效的文件夹" 
    });
  }

  const filePath = path.join(root, subPath);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ 
      success: false, 
      error: "文件不存在" 
    });
  }

  // 设置正确的Content-Type头
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.mp4': 'video/mp4',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.vtt': 'text/vtt; charset=utf-8',
    '.srt': 'text/plain; charset=utf-8',
    '.ass': 'text/plain; charset=utf-8',
    '.ssa': 'text/plain; charset=utf-8'
  };
  
  res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
  
  // 处理范围请求（视频/音频流）
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// 统一的 /api/transcode
app.get("/api/transcode", (req, res) => {
  const token = req.query.token || req.headers["authorization"];
  if (!token || !sessions[token]) {
    return res.status(401).json({ success: false, error: "未登录或会话失效" });
  }

  const {
    folder,
    path: subPath = "",
    quality = "original",
    bitrate = "auto",
    audioTrack = 0,
    audioCompatibility = "auto" // auto | compatible | original
  } = req.query;

  const root = ROOTS[folder];
  if (!root) return res.status(400).json({ success: false, error: "无效的文件夹" });

  const filePath = path.join(root, subPath);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: "文件不存在" });
  }

  // 先探测流信息，校验音轨索引
  const probe = spawn("ffprobe", ["-v","quiet","-print_format","json","-show_streams", filePath]);
  let pout = "", perr = "";
  probe.stdout.on("data", d => pout += d.toString());
  probe.stderr.on("data", d => perr += d.toString());
  probe.on("close", (code) => {
    if (code !== 0) return res.status(500).json({ success:false, error:"媒体分析失败", details: perr });

    let info;
    try { info = JSON.parse(pout); } catch { return res.status(500).json({ success:false, error:"媒体信息解析失败" }); }

    const v = (info.streams || []).find(s => s.codec_type === "video");
    const aAll = (info.streams || []).filter(s => s.codec_type === "audio");
    if (!v) return res.status(400).json({ success:false, error:"未找到视频流" });
    if (aAll.length === 0) return res.status(400).json({ success:false, error:"未找到音频流" });

    const aIdx = Number(audioTrack) || 0;
    if (aIdx < 0 || aIdx >= aAll.length) {
      return res.status(400).json({ success:false, error:`音轨索引 ${aIdx} 无效（共有 ${aAll.length} 条）` });
    }

    const vCodec = (v.codec_name || "").toLowerCase();
    const aCodec = (aAll[aIdx].codec_name || "").toLowerCase();

    const copyVideo = (quality === "original") && ["h264","hevc","av1"].includes(vCodec);

    const args = [
      "-hide_banner",
      "-i", filePath,
      "-map", "0:v:0",
      "-map", `0:a:${aIdx}?`,
      "-sn","-dn","-map_metadata","-1","-map_chapters","-1"
    ];

    // 视频：原画则 copy，否则转 H.264 并按需缩放/限码
    if (copyVideo) {
      args.push("-c:v","copy");
    } else {
      args.push("-c:v","libx264","-preset","fast");
      const scaleMap = {
        "4k":"scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2",
        "1440p":"scale=2560:1440:force_original_aspect_ratio=decrease,pad=2560:1440:(ow-iw)/2:(oh-ih)/2",
        "1080p":"scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
        "720p":"scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
        "480p":"scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2",
        "360p":"scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2"
      };
      if (scaleMap[quality]) args.push("-vf", scaleMap[quality]);
      if (bitrate !== "auto") {
        args.push("-b:v", `${bitrate}k`, "-maxrate", `${bitrate}k`, "-bufsize", `${Number(bitrate)*2}k`);
      }
    }

    // 音频：兼容模式或非 AAC → 转 AAC 立体声；否则 copy
    const needCompat = (audioCompatibility === "compatible") || (audioCompatibility === "auto" && aCodec !== "aac");
    if (needCompat) {
      args.push("-c:a","aac","-ac","2","-ar","48000","-b:a","128k");
    } else {
      // 已是 AAC 则尽量 copy
      args.push(aCodec === "aac" ? "-c:a" : "-c:a","copy");
      if (aCodec !== "aac") args.push("aac","-b:a","128k"); // 兜底
    }

    args.push("-movflags","frag_keyframe+empty_moov+faststart","-f","mp4","-");
    console.log("FFmpeg命令:", "ffmpeg", args.join(" "));

    const ff = spawn("ffmpeg", args);
    let started = false, stderrBuf = "";

    // 10s 启动看门狗：避免前端 30s 假超时
    const watchdog = setTimeout(() => {
      if (!started) {
        try { ff.kill("SIGKILL"); } catch {}
        if (!res.headersSent) res.status(504).json({ success:false, error:"转码启动超时（10s 内无输出）" });
      }
    }, 10000);

    ff.stdout.on("data", chunk => {
      if (!started) {
        clearTimeout(watchdog);
        started = true;
        res.setHeader("Content-Type","video/mp4");
        res.setHeader("Transfer-Encoding","chunked");
      }
      res.write(chunk);
    });

    ff.stderr.on("data", d => { stderrBuf += d.toString(); console.log("FFmpeg:", d.toString().trim()); });
    ff.on("error", e => { clearTimeout(watchdog); if (!res.headersSent) res.status(500).json({ success:false, error:"FFmpeg 启动失败: "+e.message }); });
    ff.on("close", code => {
      clearTimeout(watchdog);
      if (!started && !res.headersSent) return res.status(500).json({ success:false, error:`转码失败（未输出）: ${code}`, details: stderrBuf });
      try { res.end(); } catch {}
    });
    req.on("close", () => { try { ff.kill("SIGKILL"); } catch {} });
  });
});

// 在server.js中添加字幕提取API
app.get("/api/extract-subtitles", (req, res) => {
  const token = req.query.token || req.headers["authorization"];
  
  if (!token || !sessions[token]) {
    return res.status(401).json({ 
      success: false, 
      error: "未登录或会话失效" 
    });
  }

  const { folder, path: subPath = "" } = req.query;
  const root = ROOTS[folder];
  
  if (!root) {
    return res.status(400).json({ 
      success: false, 
      error: "无效的文件夹" 
    });
  }

  const filePath = path.join(root, subPath);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ 
      success: false, 
      error: "文件不存在" 
    });
  }

  // 使用FFmpeg提取字幕
  const ffmpeg = spawn('ffmpeg', [
    '-i', filePath,
    '-map', '0:s:0', // 提取第一个字幕流
    '-f', 'webvtt',
    '-'
  ]);

  let subtitleData = '';
  let errorOutput = '';

  ffmpeg.stdout.on('data', (data) => {
    subtitleData += data.toString();
  });

  ffmpeg.stderr.on('data', (data) => {
    errorOutput += data.toString();
  });

  ffmpeg.on('close', (code) => {
    if (code === 0 && subtitleData) {
      res.setHeader('Content-Type', 'text/vtt');
      res.send(subtitleData);
    } else {
      res.status(500).json({ 
        success: false, 
        error: "提取字幕失败",
        details: errorOutput
      });
    }
  });

  ffmpeg.on('error', (error) => {
    res.status(500).json({ 
      success: false, 
      error: "提取字幕失败: " + error.message
    });
  });
});

// 添加音轨信息API端点
app.get("/api/audio-tracks", (req, res) => {
  const token = req.query.token || req.headers["authorization"];
  
  if (!token || !sessions[token]) {
    return res.status(401).json({ 
      success: false, 
      error: "未登录或会话失效" 
    });
  }

  const { folder, path: subPath = "" } = req.query;
  const root = ROOTS[folder];
  
  if (!root) {
    return res.status(400).json({ 
      success: false, 
      error: "无效的文件夹" 
    });
  }

  const filePath = path.join(root, subPath);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ 
      success: false, 
      error: "文件不存在" 
    });
  }

  // 使用FFprobe获取音轨信息
  const ffprobe = spawn('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-select_streams', 'a', // 只选择音频流
    filePath
  ]);

  let output = '';
  let errorOutput = '';

  ffprobe.stdout.on('data', (data) => {
    output += data.toString();
  });

  ffprobe.stderr.on('data', (data) => {
    errorOutput += data.toString();
  });

  ffprobe.on('close', (code) => {
    if (code === 0) {
      try {
        const data = JSON.parse(output);
        const audioTracks = [];
        
        if (data.streams && data.streams.length > 0) {
          data.streams.forEach((stream, index) => {
            // 检查是否是兼容的音频格式
            const isCompatible = ['aac', 'mp3'].includes(stream.codec_name);
            
            audioTracks.push({
              index: index,
              codec: stream.codec_name || '未知',
              language: stream.tags && stream.tags.language ? stream.tags.language : '未知',
              compatible: isCompatible
              // 其他字段...
            });
          });
        }
        
        res.json({ 
          success: true, 
          audioTracks: audioTracks 
        });
      } catch (error) {
        console.error('解析FFprobe输出失败:', error);
        res.status(500).json({ 
          success: false, 
          error: "解析媒体信息失败" 
        });
      }
    } else {
      console.error('FFprobe错误:', errorOutput);
      res.status(500).json({ 
        success: false, 
        error: "获取音轨信息失败" 
      });
    }
  });

  ffprobe.on('error', (error) => {
    console.error('FFprobe启动失败:', error);
    res.status(500).json({ 
      success: false, 
      error: "无法分析媒体文件" 
    });
  });
});

// List embedded subtitle streams
app.get("/api/subtitle-tracks", (req, res) => {
  const token = req.query.token || req.headers["authorization"];
  if (!token || !sessions[token]) {
    return res.status(401).json({ success: false, error: "未登录或会话失效" });
  }

  const { folder, path: subPath = "" } = req.query;
  const root = ROOTS[folder];
  if (!root) return res.status(400).json({ success: false, error: "无效的文件夹" });

  const filePath = path.join(root, subPath);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: "文件不存在" });
  }

  const ffprobe = spawn("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    "-select_streams", "s",   // subtitle streams
    filePath
  ]);

  let output = "", errorOutput = "";
  ffprobe.stdout.on("data", d => (output += d.toString()));
  ffprobe.stderr.on("data", d => (errorOutput += d.toString()));

  ffprobe.on("close", (code) => {
    if (code !== 0) {
      return res.status(500).json({ success: false, error: "获取字幕信息失败" });
    }
    try {
      const data = JSON.parse(output);
      const tracks = (data.streams || []).map((s, idx) => ({
        indexByType: idx,                             // usable with 0:s:<idx>
        codec: s.codec_name || "unknown",
        language: (s.tags && (s.tags.language || s.tags.lang)) || "und",
        title: (s.tags && s.tags.title) || "",
        disposition: s.disposition || {}
      }));
      res.json({ success: true, subtitleTracks: tracks });
    } catch (e) {
      res.status(500).json({ success: false, error: "解析媒体信息失败" });
    }
  });
});

// Extract one embedded subtitle as WebVTT
// 提取指定内置字幕为 WebVTT：/api/extract-subtitles?folder=...&path=...&sindex=0&token=...
app.get("/api/extract-subtitles", (req, res) => {
  const token = req.query.token || req.headers["authorization"];
  if (!token || !sessions[token]) {
    return res.status(401).json({ success: false, error: "未登录或会话失效" });
  }

  const { folder, path: subPath = "", sindex = "0" } = req.query;
  const root = ROOTS[folder];
  if (!root) return res.status(400).json({ success: false, error: "无效的文件夹" });

  const filePath = path.join(root, subPath);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: "文件不存在" });
  }

  // 先探测该字幕流的编码
  const probe = spawn("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    "-select_streams", `s:${Number(sindex)}`,
    filePath
  ]);

  let pout = "", perr = "";
  probe.stdout.on("data", d => (pout += d.toString()));
  probe.stderr.on("data", d => (perr += d.toString()));

  probe.on("close", (code) => {
    if (code !== 0) {
      return res.status(500).json({ success: false, error: "获取字幕信息失败", details: perr });
    }
    try {
      const info = JSON.parse(pout || "{}");
      const s = (info.streams || [])[0];
      if (!s) return res.status(404).json({ success: false, error: "找不到对应的字幕流" });

      const codec = (s.codec_name || "").toLowerCase();
      const bitmap = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "xsub", "dvb_subtitle"]);
      if (bitmap.has(codec)) {
        // 位图字幕无法转 WebVTT，需要走“烧录”路径
        return res.status(415).json({
          success: false,
          error: "该字幕为位图字幕（PGS/DVD 等），无法直接提取为 WebVTT，请改用转码烧录。",
          codec
        });
      }

      // 文本字幕：转为 WebVTT 并流式返回
      const ff = spawn("ffmpeg", [
        "-i", filePath,
        "-map", `0:s:${Number(sindex)}`,
        "-f", "webvtt",
        "-"
      ]);

      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      ff.stdout.pipe(res);

      ff.stderr.on("data", d => console.log("FFmpeg subtitle:", d.toString()));
      ff.on("error", e => !res.headersSent && res.status(500).json({ success: false, error: "提取字幕失败: " + e.message }));
    } catch (e) {
      res.status(500).json({ success: false, error: "解析媒体信息失败" });
    }
  });
});

// 旁挂字幕转 WebVTT：/api/convert-subtitle-file?folder=...&path=...&token=...&charenc=cp936(可选)
app.get("/api/convert-subtitle-file", (req, res) => {
  const token = req.query.token || req.headers["authorization"];
  if (!token || !sessions[token]) {
    return res.status(401).json({ success: false, error: "未登录或会话失效" });
  }
  const { folder, path: subPath = "", charenc = "" } = req.query;
  const root = ROOTS[folder];
  if (!root) return res.status(400).json({ success: false, error: "无效的文件夹" });

  const filePath = path.join(root, subPath);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: "字幕文件不存在" });
  }

  const args = [];
  if (charenc) args.push("-sub_charenc", charenc); // 处理非UTF-8编码的SRT等
  args.push("-i", filePath, "-f", "webvtt", "-");

  const ff = spawn("ffmpeg", args);
  res.setHeader("Content-Type", "text/vtt; charset=utf-8");
  ff.stdout.pipe(res);
  ff.stderr.on("data", d => console.log("FFmpeg(sub):", d.toString()));
  ff.on("error", e => !res.headersSent && res.status(500).json({ success: false, error: "字幕转换失败: " + e.message }));
});

app.post("/api/opensubtitles/login", (req, res) => {
  try {
    let { username, password } = req.body || {};
    username = username || OS_CFG.USERNAME;
    password = password || OS_CFG.PASSWORD;
    if (!username || !password) {
      return res.status(400).json({ success:false, error:"缺少用户名或密码" });
    }
    osLogin(username, password)
      .then(() => res.json({ success:true, baseUrl: OS_STATE.baseUrl }))
      .catch(e => res.status(401).json({ success:false, error: e.message }));
  } catch (e) {
    res.status(500).json({ success:false, error: e.message });
  }
});

app.get("/api/opensubtitles/status", (req, res) => {
  res.json({ success:true, hasApiKey: !!OS_CFG.API_KEY, loggedIn: !!OS_STATE.token, baseUrl: OS_STATE.baseUrl });
});

app.get("/api/subtitles/auto", async (req, res) => {
  const token = req.query.token || req.headers["authorization"];
  if (!token || !sessions[token]) return res.status(401).json({ success:false, error:"未登录或会话失效" });

  const { folder, path: subPath = "", languages = "zh,en" } = req.query;
  const root = ROOTS[folder];
  if (!root) return res.status(400).json({ success:false, error:"无效的文件夹" });

  const filePath = path.join(root, subPath);
  if (!fs.existsSync(filePath)) return res.status(404).json({ success:false, error:"文件不存在" });

  try {
    const size = fs.statSync(filePath).size;
    const hash = computeOSHash(filePath);
    const qs = new URLSearchParams({
      languages, moviehash: hash, moviebytesize: String(size),
      order_by: "download_count", order_direction: "desc", ai_translated: "exclude"
    });
    const data = await osFetch(`/subtitles?${qs.toString()}`);

    const top = (data.data || [])[0];
    if (!top) return res.json({ success:true, found:false });

    // 取第一个 files.file_id 作为可下载目标
    const files = (top.attributes && top.attributes.files) || [];
    const file_id = files[0]?.file_id;
    if (!file_id) return res.json({ success:true, found:false });

    res.json({
      success:true, found:true,
      result: {
        file_id,
        language: top.attributes.language,
        release: top.attributes.release || top.attributes.feature_title,
        feature_type: top.attributes.feature_type,
        season: top.attributes.season_number,
        episode: top.attributes.episode_number
      }
    });
  } catch (e) {
    res.status(500).json({ success:false, error:"自动匹配失败：" + e.message });
  }
});

app.get("/api/subtitles/search", async (req, res) => {
  const token = req.query.token || req.headers["authorization"];
  if (!token || !sessions[token]) return res.status(401).json({ success:false, error:"未登录或会话失效" });

  const { q = "", languages = "zh,en", season = "", episode = "", year = "" } = req.query;

  try {
    const qs = new URLSearchParams({
      languages, query: q, season_number: season, episode_number: episode, year,
      order_by: "download_count", order_direction: "desc", ai_translated: "exclude"
    });
    const data = await osFetch(`/subtitles?${qs.toString()}`);
    const items = (data.data || []).slice(0, 30).map(s => ({
      id: s.id,
      language: s.attributes?.language,
      release: s.attributes?.release || s.attributes?.feature_title,
      hearing_impaired: s.attributes?.hearing_impaired,
      files: s.attributes?.files || []
    }));
    res.json({ success:true, results: items });
  } catch (e) {
    res.status(500).json({ success:false, error:"搜索失败：" + e.message });
  }
});

app.get("/api/subtitles/os/download-vtt", async (req, res) => {
  const token = req.query.token || req.headers["authorization"];
  if (!token || !sessions[token]) return res.status(401).json({ success:false, error:"未登录或会话失效" });
  if (!OS_STATE.token) { const ok = await ensureOsLogin(); if (!ok) return res.status(401).json({ success:false, error:"服务器未登录 OpenSubtitles（请配置 API Key 并登录账号）。" }); }

  const { file_id } = req.query;
  if (!file_id) return res.status(400).json({ success:false, error:"缺少 file_id" });

  try {
    // 1) 申请下载链接
    const dl = await osFetch(`/download`, { method: "POST", json: { file_id: Number(file_id) } });
    const link = dl.link;                    // 临时下载 URL（UTF-8）
    const filename = dl.file_name || "subtitle.srt";

    // 2) 下载字幕文件（可能 gzip 压缩）
    const r = await _fetch(link);
    let buf = Buffer.from(await r.arrayBuffer());
    if ((r.headers.get("content-encoding") || "").includes("gzip")) {
      buf = zlib.gunzipSync(buf);
    }

    // 3) 依据扩展名转换为 WebVTT（若本身是 .vtt 则直出）
    const lower = filename.toLowerCase();
    if (lower.endsWith(".vtt")) {
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      return res.end(buf);
    }

    // 用 FFmpeg 将 SRT/ASS/SSA 转为 VTT
    const ff = spawn("ffmpeg", [ "-i", "pipe:0", "-f", "webvtt", "pipe:1" ]);
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    ff.stdout.pipe(res);
    ff.stdin.write(buf);
    ff.stdin.end();
    ff.stderr.on("data", d => console.log("ffmpeg(sub):", d.toString()));
    ff.on("error", e => !res.headersSent && res.status(500).json({ success:false, error:"字幕转码失败: " + e.message }));
  } catch (e) {
    res.status(500).json({ success:false, error:"下载失败：" + e.message });
  }
});

// 添加文本文件读取API
app.get("/api/read-text", (req, res) => {
  const token = req.query.token || req.headers["authorization"];
  if (!token || !sessions[token]) {
    return res.status(401).json({ success: false, error: "未登录或会话失效" });
  }

  const { folder, path: subPath = "" } = req.query;
  const root = ROOTS[folder];
  if (!root) {
    return res.status(400).json({ success: false, error: "无效的文件夹" });
  }

  const filePath = path.join(root, subPath);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: "文件不存在" });
  }

  // 检查文件大小，限制为2MB
  const stats = fs.statSync(filePath);
  if (stats.size > 2 * 1024 * 1024) {
    return res.status(400).json({ success: false, error: "文件过大（最大支持2MB）" });
  }

  // 检查文件扩展名
  const ext = path.extname(filePath).toLowerCase();
  const allowedExts = ['.txt', '.c', '.cpp', '.h', '.hpp', '.py', '.js', '.html', '.css', '.java', '.json', '.xml', '.md', '.php', '.rb', '.go', '.rs', '.ts'];
  
  if (!allowedExts.includes(ext)) {
    return res.status(400).json({ success: false, error: "不支持的文本文件格式" });
  }

  // 读取文本文件
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      return res.status(500).json({ success: false, error: "读取文件失败" });
    }
    res.json({ success: true, content: data, filename: path.basename(filePath) });
  });
});

app.get("/api/lyrics/auto", async (req, res) => {
  const token = req.query.token || req.headers["authorization"];
  if (!token || !sessions[token]) return res.status(401).json({ success:false, error:"未登录或会话失效" });

  const { folder, path: subPath = "", title = "", artist = "" } = req.query;
  const root = ROOTS[folder];
  if (!root) return res.status(400).json({ success:false, error:"无效的文件夹" });

  const filePath = path.join(root, subPath);
  if (!fs.existsSync(filePath)) return res.status(404).json({ success:false, error:"文件不存在" });

  let guessTitle = title, guessArtist = artist;
  if (!guessTitle && !guessArtist) {
    const base = path.basename(filePath, path.extname(filePath));
    if (base.includes(" - ")) {
      const [a, b] = base.split(" - ").map(s => s.trim());
      guessArtist = a; guessTitle = b;
    } else {
      guessTitle = base;
    }
  }

  try {
    // 先试精准 get
    if (guessTitle) {
      let url = `${LRCLIB_BASE}/get?track_name=${encodeURIComponent(guessTitle)}`;
      if (guessArtist) url += `&artist_name=${encodeURIComponent(guessArtist)}`;
      const r = await _fetch(url);
      if (r.ok) {
        const j = await r.json();
        const lrc = composeLRCFromLrclib(j);
        if (lrc) return res.json({ success:true, found:true, lrc, title:guessTitle, artist:guessArtist });
      }
    }
    // 再退化 search
    const qs = new URLSearchParams({ track_name: guessTitle || "", artist_name: guessArtist || "" });
    const r2 = await _fetch(`${LRCLIB_BASE}/search?${qs.toString()}`);
    if (!r2.ok) return res.json({ success:true, found:false });
    const arr = await r2.json();
    if (!Array.isArray(arr) || !arr.length) return res.json({ success:true, found:false });
    const hit = arr.find(x => (x.syncedLyrics||'').trim()) || arr[0];
    const lrc = composeLRCFromLrclib(hit);
    if (!lrc) return res.json({ success:true, found:false });
    return res.json({
      success:true, found:true,
      lrc,
      title: hit.trackName || guessTitle,
      artist: hit.artistName || guessArtist
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success:false, error:"自动匹配失败：" + e.message });
  }
});

app.get("/api/lyrics/search", async (req, res) => {
  const token = req.query.token || req.headers["authorization"];
  if (!token || !sessions[token]) return res.status(401).json({ success:false, error:"未登录或会话失效" });

  const { title = "", artist = "" } = req.query;
  try {
    const qs = new URLSearchParams({ track_name: title, artist_name: artist });
    const r = await _fetch(`${LRCLIB_BASE}/search?${qs.toString()}`);
    if (!r.ok) return res.json({ success:true, results: [] });

    const arr = await r.json();
    const results = (Array.isArray(arr) ? arr : []).slice(0, 30).map(x => ({
      title: x.trackName || '',
      artist: x.artistName || '',
      hasSynced: !!(x.syncedLyrics && x.syncedLyrics.trim())
    }));
    res.json({ success:true, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success:false, error:"搜索失败：" + e.message });
  }
});

app.get("/api/lyrics/get", async (req, res) => {
  const token = req.query.token || req.headers["authorization"];
  if (!token || !sessions[token]) return res.status(401).json({ success:false, error:"未登录或会话失效" });

  const { title = "", artist = "" } = req.query;
  if (!title && !artist) return res.status(400).json({ success:false, error:"缺少标题或歌手" });

  try {
    let url = `${LRCLIB_BASE}/get?track_name=${encodeURIComponent(title)}`;
    if (artist) url += `&artist_name=${encodeURIComponent(artist)}`;
    let r = await _fetch(url);
    if (r.ok) {
      const j = await r.json();
      const lrc = composeLRCFromLrclib(j);
      res.setHeader('Content-Type','text/plain; charset=utf-8');
      return res.end(lrc || '');
    }
    // 退化 search
    const qs = new URLSearchParams({ track_name: title, artist_name: artist });
    const r2 = await _fetch(`${LRCLIB_BASE}/search?${qs.toString()}`);
    if (!r2.ok) return res.status(404).end('');
    const arr = await r2.json();
    const hit = (Array.isArray(arr) && arr.length) ? (arr.find(x => (x.syncedLyrics||'').trim()) || arr[0]) : null;
    const lrc = composeLRCFromLrclib(hit || {});
    res.setHeader('Content-Type','text/plain; charset=utf-8');
    return res.end(lrc || '');
  } catch (e) {
    console.error(e);
    res.status(500).json({ success:false, error:"获取失败：" + e.message });
  }
});

app.listen(PORT, URL, () => {
  console.log(`服务器已启动：http://${URL}:${PORT}`);
});
