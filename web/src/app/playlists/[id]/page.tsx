import { PlaylistPage } from "@/components/PlaylistPage";

export const metadata = { title: "Playlist" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlaylistPage id={id} />;
}
