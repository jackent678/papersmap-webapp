import { Suspense } from "react";
import InviteClient from "./InviteClient";

export default function InvitePage() {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>處理邀請中…</div>}>
      <InviteClient />
    </Suspense>
  );
}