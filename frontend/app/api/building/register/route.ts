import { NextRequest, NextResponse } from "next/server";

const BACKEND =
  process.env.NEXT_PUBLIC_BACKEND_HTTP || "http://127.0.0.1:8000";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();

    const response = await fetch(
      `${BACKEND}/api/v1/building/register`,
      {
        method: "POST",
        body: formData,
      }
    );

    const text = await response.text();

    return new NextResponse(text, {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get("content-type") || "application/json",
      },
    });
  } catch (error) {
    console.error("Building register proxy error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Could not connect to FastAPI backend.",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 502 }
    );
  }
}
