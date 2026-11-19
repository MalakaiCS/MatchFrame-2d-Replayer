import { Suspense } from "react";
import { MyStats } from "@/components/MyStats";

export const metadata = { title: "My stats" };

export default function Page() {
  return <Suspense><MyStats /></Suspense>;
}
