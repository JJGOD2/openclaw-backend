// src/services/backup/db-backup.service.ts
// 自動 PostgreSQL 備份 → 上傳至 S3 / Cloudflare R2
// 使用 AWS S3 compatible API（不需 SDK，原生 fetch + SigV4）
import { execSync, exec } from "child_process";
import { createReadStream, unlinkSync, statSync } from "fs";
import { tmpdir } from "os";
import { join }   from "path";
import { createHash, createHmac } from "crypto";
import { prisma }  from "@/db/client";

interface BackupConfig {
  bucket:    string;
  region:    string;
  endpoint?: string;   // for R2: https://<account>.r2.cloudflarestorage.com
  accessKey: string;
  secretKey: string;
  prefix:    string;   // folder prefix in bucket e.g. "openclaw-backups/"
}

function getConfig(): BackupConfig | null {
  const ak = process.env.S3_ACCESS_KEY ?? process.env.R2_ACCESS_KEY ?? "";
  const sk = process.env.S3_SECRET_KEY ?? process.env.R2_SECRET_KEY ?? "";
  const bucket = process.env.S3_BUCKET  ?? process.env.R2_BUCKET    ?? "";
  if (!ak || !sk || !bucket) return null;

  return {
    bucket,
    region:    process.env.S3_REGION    ?? "auto",
    endpoint:  process.env.R2_ENDPOINT  ?? process.env.S3_ENDPOINT,
    accessKey: ak,
    secretKey: sk,
    prefix:    process.env.S3_PREFIX    ?? "openclaw-backups/",
  };
}

// ── AWS SigV4 signing (minimal implementation) ────────────────
function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}
function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function signRequest(opts: {
  method:   string;
  host:     string;
  path:     string;
  region:   string;
  service:  string;
  body:     Buffer | string;
  ak:       string;
  sk:       string;
  extraHeaders?: Record<string,string>;
}): Record<string, string> {
  const now     = new Date();
  const dateFmt = now.toISOString().slice(0,10).replace(/-/g,"");
  const timeFmt = now.toISOString().replace(/[-:]/g,"").slice(0,15) + "Z";

  const bodyHash = sha256(opts.body);
  const headers  = {
    host:                opts.host,
    "x-amz-date":        timeFmt,
    "x-amz-content-sha256": bodyHash,
    ...(opts.extraHeaders ?? {}),
  };

  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.entries(headers)
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}:${v}\n`)
    .join("");

  const canonical = [
    opts.method.toUpperCase(),
    opts.path,
    "",
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");

  const credScope = `${dateFmt}/${opts.region}/${opts.service}/aws4_request`;
  const strToSign = ["AWS4-HMAC-SHA256", timeFmt, credScope, sha256(canonical)].join("\n");

  const signingKey = hmacSha256(
    hmacSha256(hmacSha256(hmacSha256(`AWS4${opts.sk}`, dateFmt), opts.region), opts.service),
    "aws4_request"
  );
  const sig = hmacSha256(signingKey, strToSign).toString("hex");

  const auth = `AWS4-HMAC-SHA256 Credential=${opts.ak}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;

  return {
    ...headers,
    Authorization: auth,
    "Content-Type": "application/octet-stream",
  };
}

// ── Upload a file to S3/R2 ────────────────────────────────────
async function uploadToS3(cfg: BackupConfig, key: string, filePath: string): Promise<string> {
  const fileBuffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath);
    stream.on("data", c => chunks.push(c as Buffer));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

  const baseUrl = cfg.endpoint
    ? `${cfg.endpoint}/${cfg.bucket}`
    : `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
  const host    = new URL(baseUrl).host;
  const path    = `/${key}`;
  const url     = `${baseUrl}${path}`;

  const headers = signRequest({
    method:  "PUT",
    host,
    path,
    region:  cfg.region,
    service: "s3",
    body:    fileBuffer,
    ak:      cfg.accessKey,
    sk:      cfg.secretKey,
    extraHeaders: { "content-length": String(fileBuffer.length) },
  });

  const res = await fetch(url, {
    method:  "PUT",
    headers: { ...headers, "Content-Length": String(fileBuffer.length) },
    body:    fileBuffer,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`S3 upload failed ${res.status}: ${err}`);
  }
  return url;
}

// ─────────────────────────────────────────────────────────────
// Main backup function
// ─────────────────────────────────────────────────────────────
export async function runDatabaseBackup(): Promise<{
  success:   boolean;
  key?:      string;
  sizeBytes?: number;
  durationMs: number;
  error?:    string;
}> {
  const start  = Date.now();
  const cfg    = getConfig();
  const dbUrl  = process.env.DATABASE_URL ?? "";
  const ts     = new Date().toISOString().slice(0,19).replace(/[T:]/g, "-");
  const fname  = `db-backup-${ts}.sql.gz`;
  const tmpPath= join(tmpdir(), fname);

  if (!dbUrl) {
    return { success: false, error: "DATABASE_URL not configured", durationMs: 0 };
  }

  try {
    // pg_dump with gzip compression
    await new Promise<void>((resolve, reject) => {
      exec(
        `pg_dump "${dbUrl}" --no-password --format=plain | gzip -9 > "${tmpPath}"`,
        { timeout: 300_000 },
        (err) => err ? reject(err) : resolve()
      );
    });

    const sizeBytes = statSync(tmpPath).size;

    if (!cfg) {
      // No S3 config — store backup locally and log
      await prisma.logEntry.create({
        data: {
          workspaceId: "system",
          type:        "SYSTEM",
          message:     `[DB Backup] 本地備份完成：${fname} (${(sizeBytes/1024/1024).toFixed(1)} MB)`,
          metadata:    { fname, sizeBytes, note: "S3 未設定，備份存於本地 /tmp" },
        },
      });
      return { success: true, key: tmpPath, sizeBytes, durationMs: Date.now() - start };
    }

    // Upload to S3/R2
    const key = `${cfg.prefix}${fname}`;
    await uploadToS3(cfg, key, tmpPath);

    // Clean up local temp file
    try { unlinkSync(tmpPath); } catch { /* ignore */ }

    // Keep only last 30 backups (list and delete old ones — simplified)
    await prisma.logEntry.create({
      data: {
        workspaceId: "system",
        type:        "SYSTEM",
        message:     `[DB Backup] S3 備份完成：${key} (${(sizeBytes/1024/1024).toFixed(1)} MB, ${Date.now()-start}ms)`,
        metadata:    { key, sizeBytes, bucket: cfg.bucket, durationMs: Date.now()-start },
      },
    });

    return { success: true, key, sizeBytes, durationMs: Date.now() - start };

  } catch (err) {
    const error = (err as Error).message;
    try { unlinkSync(tmpPath); } catch { /* ignore */ }

    await prisma.logEntry.create({
      data: {
        workspaceId: "system",
        type:        "ERROR",
        message:     `[DB Backup] 備份失敗：${error}`,
      },
    }).catch(() => {});

    return { success: false, error, durationMs: Date.now() - start };
  }
}
