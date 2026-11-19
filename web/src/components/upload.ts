/**
 * Upload one demo. Large files go up in parts (multipart) and can be resumed: the upload id is kept
 * in this browser per file (name, size, last-modified), so choosing the same file again after a
 * dropped connection or a reload continues with the parts that are missing. Each part retries.
 */
import { api, ApiError, putWithProgress } from "./api";

interface Slot {
  uploadId: string;
  upload?: { url: string; headers: Record<string, string> };
  multipart?: { partSize: number; parts: number };
}

const resumeKey = (f: File) => `mf-upload:${f.name}|${f.size}|${f.lastModified}`;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/** Forget a finished (or abandoned) upload for this file. */
export function clearResume(f: File) {
  store.del(resumeKey(f));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function uploadDemo(
  file: File,
  teamId: string | null,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
  onStatus?: (message: string) => void,
): Promise<string> {
  const key = resumeKey(file);
  let id = store.get(key);
  let partSize = 0;
  let total = 0;
  let done = new Set<number>();
  if (id) {
    try {
      const r = await api<{ partSize: number; parts: number; done: number[] }>(`/api/uploads/${id}/parts`);
      partSize = r.partSize;
      total = r.parts;
      done = new Set(r.done);
      if (done.size) onStatus?.(`Resuming: ${done.size} of ${total} parts were already uploaded.`);
    } catch {
      id = null;
      store.del(key);
    }
  }
  if (!id) {
    const slot = await api<Slot>("/api/uploads", { method: "POST", json: { filename: file.name, size: file.size, teamId, resumable: true } });
    if (slot.upload) {
      await putWithProgress(slot.upload.url, file, slot.upload.headers, onProgress, signal);
      return slot.uploadId;
    }
    id = slot.uploadId;
    partSize = slot.multipart!.partSize;
    total = slot.multipart!.parts;
    store.set(key, id);
  }
  const sizeOf = (n: number) => (n < total ? partSize : file.size - partSize * (total - 1));
  let doneBytes = [...done].reduce((a, n) => a + sizeOf(n), 0);
  onProgress(doneBytes / file.size);
  const todo = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !done.has(n));
  for (let i = 0; i < todo.length; i += 6) {
    if (signal.aborted) throw new ApiError(0, "ABORTED", "Upload cancelled. Choose the same file again to resume.");
    const batch = todo.slice(i, i + 6);
    const { targets } = await api<{ targets: { partNumber: number; size: number; upload: { url: string; headers: Record<string, string> } }[] }>(
      `/api/uploads/${id}/parts`, { method: "POST", json: { partNumbers: batch } });
    for (const t of targets) {
      const start = (t.partNumber - 1) * partSize;
      const blob = file.slice(start, start + t.size);
      for (let attempt = 1; ; attempt++) {
        try {
          await putWithProgress(t.upload.url, blob, t.upload.headers, (p) => onProgress((doneBytes + p * t.size) / file.size), signal);
          break;
        } catch (e) {
          if (signal.aborted || attempt >= 3) {
            throw new ApiError(0, "NETWORK", "The upload was interrupted. Choose the same file again to resume where it stopped.");
          }
          onStatus?.(`Connection problem; retrying part ${t.partNumber} (${attempt}/2)…`);
          await sleep(1000 * attempt * attempt);
          void e;
        }
      }
      doneBytes += t.size;
      onProgress(doneBytes / file.size);
    }
  }
  return id;
}
