import { Suspense } from "react";
import { RoundSearch } from "@/components/RoundSearch";

export const metadata = { title: "Find rounds" };

export default function Page() {
  return <Suspense><RoundSearch /></Suspense>;
}
