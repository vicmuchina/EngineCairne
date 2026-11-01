import { staticProjectParams } from "@/lib/static-project-params";

import ProjectDetailPage from "./project-detail";

/**
 * `output: export` requires every dynamic route to declare its params. Cairn
 * project ids are runtime data, so ask the backend at build time and degrade to
 * an empty list when it is unreachable; the normal server build still renders
 * any project id on demand because `dynamicParams` defaults to true.
 */
export async function generateStaticParams(): Promise<{ id: string }[]> {
  return staticProjectParams();
}

export default function Page() {
  return <ProjectDetailPage />;
}
