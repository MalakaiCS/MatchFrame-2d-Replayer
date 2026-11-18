import { Suspense } from "react";
import { ReplayViewer } from "@/components/viewer/ReplayViewer";

export const metadata = { title: "Replay", referrer: "no-referrer" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <ReplayViewer id={id} />
    </Suspense>
  );
}
