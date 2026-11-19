import { Suspense } from "react";
import { RoundCompare } from "@/components/RoundCompare";

export const metadata = { title: "Compare rounds" };

export default function Page() {
  return <Suspense><RoundCompare /></Suspense>;
}
