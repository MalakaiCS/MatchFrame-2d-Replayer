/**
 * Private object storage. "fs" is for local development; "s3" works with any
 * S3-compatible bucket (Railway buckets, R2, MinIO, AWS). Readers never get a
 * long-lived storage URL: objects are streamed through authorised routes.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { env } from "./env";
import { hmac, safeEqual } from "./ids";

export interface UploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
}

export interface ObjectStream {
  body: ReadableStream<Uint8Array>;
  size: number;
  start: number;
  end: number;
  total: number;
}

export interface Storage {
  createUploadTarget(key: string, size: number, maxBytes: number, contentType: string): Promise<UploadTarget>;
  size(key: string): Promise<number | null>;
  readHead(key: string, n: number): Promise<Buffer>;
  read(key: string): Promise<Buffer>;
  stream(key: string, range?: { start: number; end?: number }): Promise<ObjectStream | null>;
  delete(key: string): Promise<void>;
}

export function assertSafeKey(key: string) {
  if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.startsWith("/") || key.split("/").includes("..")) {
    throw new Error("unsafe object key");
  }
}

// ---------------------------------------------------------------- fs driver

export function signFsUpload(key: string, size: number, exp: number) {
  return hmac(env.signingSecret(), `upload|${key}|${size}|${exp}`);
}

export function verifyFsUpload(key: string, size: number, exp: number, sig: string) {
  return exp * 1000 > Date.now() && safeEqual(sig, signFsUpload(key, size, exp));
}

class FsStorage implements Storage {
  root = path.resolve(env.storageFsRoot);
  p(key: string) {
    assertSafeKey(key);
    return path.join(this.root, key);
  }
  async createUploadTarget(key: string, size: number): Promise<UploadTarget> {
    const exp = Math.floor(Date.now() / 1000) + env.uploadSlotSeconds;
    const qs = new URLSearchParams({ key, size: String(size), exp: String(exp), sig: signFsUpload(key, size, exp) });
    return { method: "PUT", url: `/api/storage/upload?${qs}`, headers: { "Content-Type": "application/octet-stream" } };
  }
  async writeStream(key: string, body: ReadableStream<Uint8Array>, exactSize: number) {
    const file = this.p(key);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.part`;
    const out = createWriteStream(tmp);
    let n = 0;
    try {
      for await (const chunk of Readable.fromWeb(body as never)) {
        n += (chunk as Buffer).length;
        if (n > exactSize) throw new Error("TOO_LARGE");
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      }
      await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
      if (n !== exactSize) throw new Error("SIZE_MISMATCH");
      await rename(tmp, file);
      return n;
    } catch (e) {
      out.destroy();
      await rm(tmp, { force: true });
      throw e;
    }
  }
  async size(key: string) {
    try {
      const s = await stat(this.p(key));
      return s.isFile() ? s.size : null;
    } catch {
      return null;
    }
  }
  async readHead(key: string, n: number) {
    const fh = await open(this.p(key), "r");
    try {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }
  async read(key: string) {
    const { readFile } = await import("node:fs/promises");
    return readFile(this.p(key));
  }
  async stream(key: string, range?: { start: number; end?: number }) {
    const total = await this.size(key);
    if (total === null) return null;
    const start = Math.min(range?.start ?? 0, Math.max(total - 1, 0));
    const end = Math.min(range?.end ?? total - 1, total - 1);
    const node = createReadStream(this.p(key), { start, end });
    return { body: Readable.toWeb(node) as ReadableStream<Uint8Array>, size: end - start + 1, start, end, total };
  }
  async delete(key: string) {
    await rm(this.p(key), { force: true });
  }
}

// ---------------------------------------------------------------- s3 driver

class S3Storage implements Storage {
  private clientPromise = (async () => {
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({ region: env.s3Region, endpoint: env.s3Endpoint, forcePathStyle: true });
  })();
  private publicClientPromise = (async () => {
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({ region: env.s3Region, endpoint: env.s3PublicEndpoint, forcePathStyle: true });
  })();

  async createUploadTarget(key: string, size: number, _max: number, contentType: string): Promise<UploadTarget> {
    assertSafeKey(key);
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    // ContentLength is signed, so the bucket rejects any body that is not exactly `size` bytes.
    const cmd = new PutObjectCommand({ Bucket: env.s3Bucket, Key: key, ContentLength: size, ContentType: contentType });
    const url = await getSignedUrl(await this.publicClientPromise, cmd, {
      expiresIn: env.uploadSlotSeconds,
      signableHeaders: new Set(["content-length", "content-type"]),
    });
    return { method: "PUT", url, headers: { "Content-Type": contentType } };
  }
  async size(key: string) {
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    try {
      const r = await (await this.clientPromise).send(new HeadObjectCommand({ Bucket: env.s3Bucket, Key: key }));
      return r.ContentLength ?? null;
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw e;
    }
  }
  async readHead(key: string, n: number) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const r = await (await this.clientPromise).send(new GetObjectCommand({ Bucket: env.s3Bucket, Key: key, Range: `bytes=0-${n - 1}` }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async read(key: string) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const r = await (await this.clientPromise).send(new GetObjectCommand({ Bucket: env.s3Bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async stream(key: string, range?: { start: number; end?: number }) {
    const total = await this.size(key);
    if (total === null) return null;
    const start = Math.min(range?.start ?? 0, Math.max(total - 1, 0));
    const end = Math.min(range?.end ?? total - 1, total - 1);
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const r = await (await this.clientPromise).send(
      new GetObjectCommand({ Bucket: env.s3Bucket, Key: key, Range: range ? `bytes=${start}-${end}` : undefined }),
    );
    return { body: r.Body!.transformToWebStream() as ReadableStream<Uint8Array>, size: end - start + 1, start, end, total };
  }
  async delete(key: string) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.clientPromise).send(new DeleteObjectCommand({ Bucket: env.s3Bucket, Key: key }));
  }
}

let storage: Storage | null = null;
export function getStorage(): Storage {
  if (!storage) storage = env.storageDriver === "s3" ? new S3Storage() : new FsStorage();
  return storage;
}
export function getFsStorage(): FsStorage {
  const s = getStorage();
  if (!(s instanceof FsStorage)) throw new Error("fs storage not active");
  return s;
}
