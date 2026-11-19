import { JoinTeam } from "@/components/JoinTeam";

export const metadata = { title: "Join team", referrer: "no-referrer" };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <JoinTeam token={token} />;
}
