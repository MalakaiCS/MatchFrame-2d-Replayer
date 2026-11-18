/** Server-side configuration. Never import from client components. */
export const env = {
  appOrigin: process.env.APP_ORIGIN ?? "http://localhost:3000",
  maxDemoBytes: Number(process.env.MAX_DEMO_BYTES ?? 512 * 1024 * 1024),
  maxAudioBytes: Number(process.env.MAX_AUDIO_BYTES ?? 300 * 1024 * 1024),
  uploadSlotSeconds: Number(process.env.UPLOAD_SLOT_SECONDS ?? 15 * 60),
  pendingSourceTtlSeconds: Number(process.env.PENDING_SOURCE_TTL_S ?? 3 * 24 * 3600),
  streamUrlSeconds: Number(process.env.STREAM_URL_SECONDS ?? 10 * 60),
  storageDriver: (process.env.STORAGE_DRIVER ?? "fs") as "fs" | "s3",
  storageFsRoot: process.env.STORAGE_FS_ROOT ?? "./.data/objects",
  s3Bucket: process.env.S3_BUCKET ?? "",
  s3Endpoint: process.env.S3_ENDPOINT || undefined,
  s3PublicEndpoint: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || undefined,
  s3Region: process.env.S3_REGION ?? "auto",
  signingSecret: () => {
    const s = process.env.AUTH_SECRET;
    if (!s || s.length < 32) throw new Error("AUTH_SECRET must be set (at least 32 characters)");
    return s;
  },
  allowSignup: process.env.ALLOW_SIGNUP !== "0",
};
