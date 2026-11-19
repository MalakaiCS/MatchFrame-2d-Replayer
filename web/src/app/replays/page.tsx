import { Suspense } from "react";
import { Library } from "@/components/Library";

export const metadata = { title: "Personal demos" };

export default function Page() {
  return <Suspense><Library /></Suspense>;
}
