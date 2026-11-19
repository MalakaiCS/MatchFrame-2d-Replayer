import { Suspense } from "react";
import { BillingPage } from "@/components/BillingPage";

export const metadata = { title: "Plans & billing" };

export default function Page() {
  return <Suspense><BillingPage /></Suspense>;
}
