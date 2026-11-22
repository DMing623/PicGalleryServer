// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { Suspense } from "react";
import Gallery from "@/components/Gallery";

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <Gallery />
    </Suspense>
  );
}
