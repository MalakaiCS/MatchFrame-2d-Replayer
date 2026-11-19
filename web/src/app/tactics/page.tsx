import { Suspense } from "react";
import { TacticBoardList } from "@/components/TacticBoard";

export const metadata = { title: "Tactic boards" };

export default function Page() {
  return <Suspense><TacticBoardList /></Suspense>;
}
