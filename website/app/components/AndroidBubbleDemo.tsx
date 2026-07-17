"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

// Colors match the real device UI exactly (BubbleSuggestionActivity.kt / BubbleHelper.kt),
// not the marketing purple used elsewhere on this site — this is meant to be a faithful
// recreation of what actually renders on-device.
const PURPLE = "#6366f1";
const PURPLE_BG = "rgba(99,102,241,0.13)";
const TEXT = "#f4f4f5";
const MUTED = "#71717a";
const BG = "#1e1e22";
const SURFACE2 = "#27272a";
const BORDER = "#3f3f46";

type Phase = "idle" | "notification" | "bubble" | "thinking" | "expanded" | "sent";

const DURATIONS: Record<Phase, number> = {
  idle: 700,
  notification: 3400,
  bubble: 1200,
  thinking: 2600,
  expanded: 5200,
  sent: 1600,
};

const ORDER: Phase[] = ["idle", "notification", "bubble", "thinking", "expanded", "sent"];

// The actual signals ProTxtBgService/WorkerClient gather before a reply comes back —
// this is what the loading state is really waiting on, not a generic spinner.
const SIGNALS = [
  { icon: "📅", label: "Checking your calendar" },
  { icon: "📍", label: "Getting your live ETA" },
  { icon: "💬", label: "Reading the conversation so far" },
  { icon: "🧠", label: "Matching your usual tone with Jamie" },
];

function StatusBar() {
  return (
    <div className="flex items-center justify-between px-4 pt-2.5 pb-1.5 text-white/90 text-[11px] font-medium relative z-20">
      <span>9:41</span>
      <div className="flex items-center gap-1.5">
        <svg width="15" height="11" viewBox="0 0 15 11" fill="none">
          <rect x="0" y="7" width="2.5" height="4" rx="0.5" fill="currentColor" />
          <rect x="4" y="5" width="2.5" height="6" rx="0.5" fill="currentColor" />
          <rect x="8" y="3" width="2.5" height="8" rx="0.5" fill="currentColor" />
          <rect x="12" y="0" width="2.5" height="11" rx="0.5" fill="currentColor" opacity="0.5" />
        </svg>
        <svg width="14" height="11" viewBox="0 0 14 11" fill="none">
          <path d="M1 4.2C4.8.6 9.2.6 13 4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
          <path d="M3.4 6.8C5.7 4.6 8.3 4.6 10.6 6.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
          <circle cx="7" cy="9.3" r="1.1" fill="currentColor" />
        </svg>
        <svg width="22" height="11" viewBox="0 0 22 11" fill="none">
          <rect x="0.75" y="0.75" width="18.5" height="9.5" rx="2.25" stroke="currentColor" strokeWidth="1.1" />
          <rect x="20.5" y="3.5" width="1.5" height="4" rx="0.75" fill="currentColor" />
          <rect x="2" y="2" width="15" height="7" rx="1.2" fill="currentColor" />
        </svg>
      </div>
    </div>
  );
}

export default function AndroidBubbleDemo() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [thinkingStep, setThinkingStep] = useState(0);

  useEffect(() => {
    let idx = 0;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      idx = (idx + 1) % ORDER.length;
      setPhase(ORDER[idx]);
      timer = setTimeout(step, DURATIONS[ORDER[idx]]);
    };
    timer = setTimeout(step, DURATIONS[ORDER[idx]]);
    return () => clearTimeout(timer);
  }, []);

  // Signal rows check in one at a time while "thinking" — driven by its own
  // interval so the stagger replays cleanly every loop.
  useEffect(() => {
    if (phase !== "thinking") { setThinkingStep(0); return; }
    setThinkingStep(0);
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setThinkingStep(i);
      if (i >= SIGNALS.length) clearInterval(id);
    }, 560);
    return () => clearInterval(id);
  }, [phase]);

  const showNotification = phase === "notification";
  const showPanel = phase === "thinking" || phase === "expanded" || phase === "sent";
  const showResult = phase === "expanded" || phase === "sent";
  const isSent = phase === "sent";

  return (
    <div
      className="relative w-full overflow-hidden rounded-[2rem] border border-white/10"
      style={{ height: 500, background: "radial-gradient(circle at 30% 20%, #1a1730 0%, #0d0c16 60%, #09080f 100%)" }}
    >
      <StatusBar />

      {/* home-screen dock, purely decorative — reads as "floats over whatever you're doing" */}
      <div className="absolute bottom-6 left-0 right-0 flex justify-center gap-3 z-0">
        {["#3b82f6", "#22c55e", "#f59e0b", "#ec4899"].map((c, i) => (
          <div key={i} className="w-11 h-11 rounded-2xl" style={{ background: `${c}26`, border: `1px solid ${c}40` }} />
        ))}
      </div>

      {/* Heads-up notification */}
      <div
        className="absolute left-3 right-3 z-30 ease-out"
        style={{
          top: showNotification ? 14 : -110,
          opacity: showNotification ? 1 : 0,
          transition: "top 900ms ease-out, opacity 900ms ease-out",
        }}
      >
        <div className="rounded-2xl px-3.5 py-3 shadow-lg" style={{ background: "#1f1f24", border: "1px solid rgba(255,255,255,0.08)" }}>
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-4 h-4 rounded-full flex items-center justify-center shrink-0" style={{ background: "#25D366" }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="white"><path d="M12 2a10 10 0 0 0-8.5 15.2L2 22l4.9-1.5A10 10 0 1 0 12 2z" /></svg>
            </div>
            <span className="text-[11px] font-medium" style={{ color: "rgba(255,255,255,0.5)" }}>WhatsApp · now</span>
          </div>
          <p className="text-[13px] font-semibold text-white leading-snug">Jamie Kim</p>
          <p className="text-[13px] leading-snug" style={{ color: "rgba(255,255,255,0.7)" }}>
            Hey, when are you getting here? We&apos;re saving you a seat
          </p>
        </div>
      </div>

      {/* Floating chat-head bubble — sits below the status bar, like a real Android chat head */}
      <div
        className="absolute z-20"
        style={{
          right: 18,
          top: 46,
          opacity: phase === "bubble" ? 1 : 0,
          transform: phase === "bubble" ? "scale(1)" : "scale(0.4)",
          transition: "opacity 700ms ease-out, transform 700ms ease-out",
        }}
      >
        <div className="relative">
          <div
            className="w-14 h-14 rounded-full overflow-hidden shadow-lg"
            style={{ boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}
          >
            <Image src="/contxt-bubble-icon.png" alt="" width={56} height={56} />
          </div>
          {!showPanel && (
            <div
              className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white"
              style={{ background: "#ef4444", border: "2px solid #0d0c16" }}
            >
              1
            </div>
          )}
        </div>
      </div>

      {/* Expanded bubble sheet — recreates BubbleSuggestionActivity 1:1 */}
      <div
        className="absolute left-3 right-3 z-30 rounded-2xl ease-out overflow-hidden"
        style={{
          bottom: 76,
          background: BG,
          border: "1px solid rgba(255,255,255,0.06)",
          opacity: showPanel ? 1 : 0,
          transform: showPanel ? "translateY(0) scale(1)" : "translateY(24px) scale(0.92)",
          boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
          pointerEvents: "none",
          transition: "opacity 900ms ease-out, transform 900ms ease-out",
        }}
      >
        <div className="px-4 pt-4 pb-4">
          {/* header */}
          <div className="flex items-center gap-2.5 mb-3.5">
            <div
              className="w-[38px] h-[38px] rounded-full flex items-center justify-center text-[15px] font-bold text-white shrink-0"
              style={{ background: "#3b82f6" }}
            >
              J
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-bold leading-tight truncate" style={{ color: TEXT }}>Jamie Kim</p>
              <p className="text-[11px] leading-tight" style={{ color: MUTED }}>WhatsApp</p>
            </div>
            <span className="text-[16px]" style={{ color: PURPLE }}>↗</span>
          </div>

          {/* quoted message */}
          <div className="flex gap-2.5 mb-3">
            <div className="w-[3px] rounded-full shrink-0" style={{ background: BORDER }} />
            <p className="text-[13px] leading-relaxed" style={{ color: MUTED }}>
              Hey, when are you getting here? We&apos;re saving you a seat
            </p>
          </div>

          {showResult ? (
            <>
              {/* tone pills */}
              <div className="flex gap-1.5 mb-3.5">
                {["Casual", "Formal", "Brief"].map((tone, i) => (
                  <span
                    key={tone}
                    className="flex-1 text-center text-[12px] py-1.5 rounded-full"
                    style={
                      i === 0
                        ? { background: PURPLE_BG, color: PURPLE, border: `1px solid ${PURPLE}`, fontWeight: 700 }
                        : { color: MUTED, border: `1px solid ${BORDER}` }
                    }
                  >
                    {tone}
                  </span>
                ))}
              </div>

              {/* reply box */}
              <div className="rounded-[10px] px-3 py-2.5 mb-3" style={{ background: SURFACE2 }}>
                <p className="text-[15px]" style={{ color: TEXT }}>On my way, 10 min!</p>
              </div>

              {/* send button */}
              <div
                className="w-full text-center rounded-xl py-3 text-[15px] font-bold"
                style={{
                  background: isSent ? "#22c55e" : PURPLE,
                  color: "white",
                  transition: "background 600ms ease-out",
                }}
              >
                {isSent ? "Sent" : "Send"}
              </div>
            </>
          ) : (
            /* Signal check-in — what the worker actually gathers before replying */
            <div className="flex flex-col gap-2.5 py-1">
              {SIGNALS.map((s, i) => {
                const active = thinkingStep > i;
                return (
                  <div
                    key={s.label}
                    className="flex items-center gap-2.5"
                    style={{ transition: "opacity 400ms ease-out", opacity: active ? 1 : 0.4 }}
                  >
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center text-[12px] shrink-0"
                      style={{
                        background: active ? PURPLE_BG : "transparent",
                        border: `1px solid ${active ? PURPLE : BORDER}`,
                        transition: "background 400ms ease-out, border-color 400ms ease-out",
                      }}
                    >
                      {s.icon}
                    </div>
                    <p className="text-[13px] flex-1" style={{ color: active ? TEXT : MUTED, transition: "color 400ms ease-out" }}>
                      {s.label}
                    </p>
                    <span
                      className="text-[12px] font-bold"
                      style={{ color: "#22c55e", opacity: active ? 1 : 0, transition: "opacity 300ms ease-out" }}
                    >
                      ✓
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
