import express from "express";
import cors from "cors";
import multer from "multer";
import rateLimit from "express-rate-limit";
import ffmpeg from "fluent-ffmpeg";
import archiver from "archiver";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const app = express();
const PORT = process.env.PORT || 3000;
const origins = (process.env.FRONTEND_ORIGIN || "*").split(",");
const work = process.env.WORK_DIR || os.tmpdir();

app.use(cors({ origin: origins.includes("*") ? true : origins }));
app.use(express.json({ limit: "1mb" }));
app.use("/api/", rateLimit({ windowMs: 60000, limit: 10 }));

const upload = multer({
  dest: path.join(work, "clipforge-uploads"),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith("video/")
      ? cb(null, true)
      : cb(new Error("Upload a video file."))
});

app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "clipforge-video-backend" })
);

app.post("/api/process-upload", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Choose a video first." });
  }

  const n = Number.parseInt(req.body.clipSeconds || "30", 10);
  const seconds = Math.min(60, Math.max(15, Number.isFinite(n) ? n : 30));
  const dir = path.join(work, "clipforge-jobs", randomUUID());

  fs.mkdirSync(dir, { recursive: true });

  try {
    const duration = await new Promise((resolve, reject) =>
      ffmpeg.ffprobe(req.file.path, (err, data) =>
        err ? reject(err) : resolve(Number(data.format.duration))
      )
    );

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Could not read video duration.");
    }

    const count = Math.min(20, Math.ceil(duration / seconds));
    const outputs = [];

    for (let i = 0; i < count; i++) {
      const output = path.join(
        dir,
        `clip-${String(i + 1).padStart(2, "0")}.mp4`
      );

      await new Promise((resolve, reject) =>
        ffmpeg(req.file.path)
          .setStartTime(i * seconds)
          .setDuration(Math.min(seconds, duration - i * seconds))
          .videoCodec("libx264")
          .audioCodec("aac")
          .outputOptions(["-preset veryfast", "-movflags +faststart"])
          .output(output)
          .on("end", resolve)
          .on("error", reject)
          .run()
      );

      outputs.push(output);
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="clipforge-clips.zip"'
    );

    const zip = archiver("zip", { zlib: { level: 5 } });
    zip.on("error", err => res.destroy(err));
    zip.pipe(res);

    outputs.forEach(file =>
      zip.file(file, { name: path.basename(file) })
    );

    await zip.finalize();

    res.on("close", () => {
      fs.rm(dir, { recursive: true, force: true });
      fs.rm(req.file.path, { force: true });
    });
  } catch (err) {
    fs.rm(dir, { recursive: true, force: true });
    fs.rm(req.file.path, { force: true });

    if (!res.headersSent) {
      res.status(500).json({
        error: err.message || "Processing failed."
      });
    }
  }
});

app.use((err, _req, res, _next) =>
  res.status(400).json({ error: err.message || "Request failed." })
);

app.listen(PORT, () =>
  console.log(`Clipforge backend listening on ${PORT}`)
);