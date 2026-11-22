import AlbumsView from "@/components/AlbumsView";

export default async function AlbumPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <AlbumsView code={code} />;
}
