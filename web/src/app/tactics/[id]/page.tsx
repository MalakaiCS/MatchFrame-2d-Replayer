import { TacticBoardEditor } from "@/components/TacticBoard";

export const metadata = { title: "Tactic board" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TacticBoardEditor id={id} />;
}
