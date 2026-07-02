import { Resend } from "resend";
import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { email } = await req.json();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "Invalid email" }, { status: 400 });
  }

  try {
    await resend.contacts.create({
      email,
      audienceId: process.env.RESEND_AUDIENCE_ID!,
    });

    await resend.emails.send({
      from: "ConTxt <hello@get-contxt.app>",
      to: email,
      subject: "You're on the ConTxt waitlist",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#111">
          <p style="font-size:20px;font-weight:500;margin:0 0 16px">You're in. ✓</p>
          <p style="color:#555;line-height:1.6;margin:0 0 16px">
            Thanks for joining the ConTxt waitlist. We're putting the finishing touches on the
            Android beta and will reach out as soon as a spot opens up.
          </p>
          <p style="color:#555;line-height:1.6;margin:0">
            — The ConTxt team
          </p>
        </div>
      `,
    });

    return Response.json({ ok: true });
  } catch (err) {
    console.error("Waitlist error:", err);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}
