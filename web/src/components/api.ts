"use client";

/** Client-side API helper. Sends the share token (from the URL fragment) in a header, never in the URL. */
let shareToken: string | null = null;

export function setShareToken(t: string | null) {
  shareToken = t;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (shareToken) headers.set("X-Share-Token", shareToken);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, headers, body, credentials: "same-origin", cache: "no-store" });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? "HTTP_" + res.status, data?.error?.message ?? res.statusText);
  }
  return data as T;
}

/** Upload with progress (fetch has no upload progress). */
export function putWithProgress(url: string, file: Blob, headers: Record<string, string>, onProgress: (f: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, "UPLOAD_FAILED", `Upload failed (${xhr.status}).`)));
    xhr.onerror = () => reject(new ApiError(0, "NETWORK", "The upload was interrupted. Check your connection and try again."));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}
