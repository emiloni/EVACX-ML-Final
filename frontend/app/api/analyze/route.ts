import { NextRequest, NextResponse } from "next/server";

const BACKEND =
  process.env.NEXT_PUBLIC_BACKEND_HTTP ||
  "http://127.0.0.1:8000";

export async function POST(
  request: NextRequest
) {
  try {
    const incomingForm =
      await request.formData();

    const mobility =
      request.nextUrl.searchParams.get(
        "mobility"
      ) || "normal";

    const response = await fetch(
      `${BACKEND}/api/analyze-and-route?mobility=${encodeURIComponent(
        mobility
      )}`,
      {
        method: "POST",
        body: incomingForm,
      }
    );

    const text =
      await response.text();

    return new NextResponse(text, {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get(
            "content-type"
          ) ||
          "application/json",
      },
    });

  } catch (error) {

    console.error(
      "AI proxy error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error:
          "Could not connect to FastAPI backend.",
        details:
          error instanceof Error
            ? error.message
            : String(error),
      },
      {
        status: 502,
      }
    );
  }
}