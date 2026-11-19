import { Suspense } from "react";
import { Library } from "@/components/Library";

export const metadata = { title: "Team demos" };

export default function Page() {
  return <Suspense><Library space="team" /></Suspense>;
}
