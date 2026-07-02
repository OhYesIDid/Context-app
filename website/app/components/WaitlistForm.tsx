"use client";

import { useState } from "react";

export default function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("loading");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <p className="text-sm text-zinc-500">
        <span className="inline-block w-4 h-4 rounded-full bg-green-500 mr-2 align-middle" />
        You&apos;re on the list — we&apos;ll be in touch.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex gap-2 max-w-sm mx-auto">
      <input
        type="email"
        required
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="flex-1 px-4 py-2.5 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#534AB7]/40 bg-white"
      />
      <button
        type="submit"
        disabled={state === "loading"}
        className="px-5 py-2.5 text-sm font-medium text-white bg-[#534AB7] rounded-lg hover:bg-[#3C3489] transition-colors disabled:opacity-60"
      >
        {state === "loading" ? "..." : "Join waitlist"}
      </button>
      {state === "error" && (
        <p className="text-xs text-red-500 mt-1 w-full">Something went wrong — try again.</p>
      )}
    </form>
  );
}
