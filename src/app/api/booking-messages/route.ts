import { NextResponse } from "next/server";
import { loadPublicBookingMessages } from "@/lib/booking-message-settings";

export async function GET() {
  return NextResponse.json({
    messages: await loadPublicBookingMessages(),
  });
}
