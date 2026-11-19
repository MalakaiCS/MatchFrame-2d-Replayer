import { Suspense } from "react";
import { UploadFlow } from "@/components/UploadFlow";

export const metadata = { title: "Upload" };

export default function Page() {
  return <Suspense><UploadFlow /></Suspense>;
}
