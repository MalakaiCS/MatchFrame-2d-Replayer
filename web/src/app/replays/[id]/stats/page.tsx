import { MatchStats } from "@/components/MatchStats";

export const metadata = { title: "Match stats", referrer: "no-referrer" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MatchStats id={id} />;
}
