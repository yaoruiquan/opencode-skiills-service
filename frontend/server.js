const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const HOST = process.env.FRONTEND_HOST || "0.0.0.0";
const PORT = Number(process.env.FRONTEND_PORT || 4101);
const ROOT = __dirname;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function safeTarget(urlPath) {
  const pathname = decodeURIComponent(urlPath.split("?")[0]);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(ROOT, relative);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    return null;
  }
  return target;
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }

  const target = safeTarget(req.url || "/");
  if (!target) {
    res.writeHead(400);
    res.end("bad request");
    return;
  }

  try {
    const data = await fs.readFile(target);
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(target)] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(data);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(500);
    res.end("internal error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`frontend listening on http://${HOST}:${PORT}`);
});
