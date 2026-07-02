import WaitlistForm from "./components/WaitlistForm";
import ParticleBackground from "./components/ParticleBackground";

const steps = [
  {
    n: "1",
    title: "Message arrives",
    body: "A notification comes in from WhatsApp, iMessage, Telegram, or any other app you've enabled.",
  },
  {
    n: "2",
    title: "ConTxt reads the intent",
    body: "We detect what the message is asking — an ETA, availability check, quick question, or casual chat.",
  },
  {
    n: "3",
    title: "Context is gathered",
    body: "Your calendar, location, and conversation history inform 2–3 tonal reply options in real time.",
  },
  {
    n: "4",
    title: "Tap and send",
    body: "The reply bubble floats over your screen. One tap copies or sends — without leaving what you were doing.",
  },
];

const features = [
  {
    icon: "📅",
    title: "Calendar-aware",
    body: "Knows if you're in a meeting, free, or running between things.",
  },
  {
    icon: "📍",
    title: "Location-smart",
    body: "Estimates your ETA automatically using your real-time location.",
  },
  {
    icon: "🎚️",
    title: "Tone options",
    body: "Every reply comes in brief, casual, and formal — pick what fits.",
  },
  {
    icon: "💬",
    title: "No app switching",
    body: "Floating bubble stays out of your way until you need it.",
  },
  {
    icon: "📱",
    title: "Works everywhere",
    body: "WhatsApp, iMessage, Telegram, Messenger, and more.",
  },
  {
    icon: "🔒",
    title: "Private by design",
    body: "Message content is never stored. Replies are generated and gone.",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen">
      {/* Hero with particle background */}
      <div className="relative overflow-hidden" style={{ background: "#0f0d1f" }}>
        <ParticleBackground />

        {/* Nav */}
        <nav className="relative z-10 flex items-center justify-between px-6 py-4 border-b border-white/10 max-w-5xl mx-auto">
          <span className="text-lg font-medium tracking-tight text-white">
            Con<span className="text-[#AFA9EC]">Txt</span>
          </span>
          <div className="flex items-center gap-6">
            <a href="#how-it-works" className="text-sm text-white/50 hover:text-white transition-colors hidden sm:block">
              How it works
            </a>
            <a href="#features" className="text-sm text-white/50 hover:text-white transition-colors hidden sm:block">
              Features
            </a>
            <a
              href="#waitlist"
              className="text-sm font-medium text-white bg-[#534AB7] px-4 py-2 rounded-lg hover:bg-[#3C3489] transition-colors"
            >
              Get early access
            </a>
          </div>
        </nav>

        {/* Hero */}
        <section className="relative z-10 text-center px-6 pt-20 pb-16 max-w-3xl mx-auto">
        <div className="inline-block text-xs font-medium text-[#AFA9EC] bg-[#534AB7]/30 px-3 py-1 rounded-full mb-6">
          AI-powered replies
        </div>
        <h1 className="text-4xl sm:text-5xl font-medium tracking-tight leading-tight mb-5 text-white">
          Reply smarter,<br />
          without switching <span className="text-[#AFA9EC]">apps</span>
        </h1>
        <p className="text-lg text-white/50 leading-relaxed mb-8 max-w-md mx-auto">
          ConTxt reads your incoming messages and surfaces the perfect reply — right where you are.
          No copy-paste, no context switching.
        </p>
        <div className="flex gap-3 justify-center flex-wrap mb-4">
          <a
            href="#waitlist"
            className="px-6 py-3 text-sm font-medium text-white bg-[#534AB7] rounded-lg hover:bg-[#3C3489] transition-colors"
          >
            Get early access
          </a>
          <a
            href="#how-it-works"
            className="px-6 py-3 text-sm font-medium text-white/80 border border-white/20 rounded-lg hover:bg-white/10 transition-colors"
          >
            See how it works
          </a>
        </div>
        <p className="text-xs text-white/30">Android first · iOS coming soon</p>
      </section>

      {/* Phone mockup */}
      <div className="relative z-10 max-w-xs mx-auto mb-20 rounded-3xl border border-white/10 bg-white/5 overflow-hidden shadow-sm">
        <div className="flex items-center gap-3 px-4 py-3 bg-white/10 border-b border-white/10">
          <div className="w-8 h-8 rounded-full bg-[#534AB7]/40 flex items-center justify-center text-xs font-medium text-[#AFA9EC]">
            JK
          </div>
          <div>
            <p className="text-sm font-medium leading-none text-white">Jamie Kim</p>
            <p className="text-xs text-white/40 mt-0.5">iMessage</p>
          </div>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <div className="max-w-[80%] bg-white/10 border border-white/10 rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm leading-relaxed text-white/80">
            Hey, when are you getting here? We&apos;re saving you a seat
          </div>
          <div className="bg-white/10 border border-[#AFA9EC]/40 rounded-2xl p-3">
            <p className="text-xs font-medium text-[#AFA9EC] mb-2">⚡ ConTxt suggests</p>
            <div className="flex flex-wrap gap-1.5">
              {["On my way, 10 min!", "Running 5 min late", "Leaving now"].map((chip) => (
                <span
                  key={chip}
                  className="text-xs px-3 py-1.5 rounded-full bg-[#534AB7]/40 text-[#CECBF6] cursor-pointer hover:bg-[#534AB7]/60 transition-colors"
                >
                  {chip}
                </span>
              ))}
            </div>
          </div>
          <div className="max-w-[80%] self-end bg-[#534AB7] text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm leading-relaxed">
            On my way, 10 min!
          </div>
        </div>
      </div>
      </div>{/* end particle background wrapper */}

      <hr className="border-zinc-100 max-w-5xl mx-auto" />

      {/* How it works */}
      <section id="how-it-works" className="px-6 py-16 max-w-2xl mx-auto">
        <p className="text-xs font-medium text-[#534AB7] tracking-widest uppercase mb-3">How it works</p>
        <h2 className="text-2xl font-medium tracking-tight mb-3">From notification to reply in seconds</h2>
        <p className="text-zinc-500 leading-relaxed mb-10">
          ConTxt catches incoming messages and generates context-aware replies before you even open the app.
        </p>
        <div className="divide-y divide-zinc-100">
          {steps.map((s) => (
            <div key={s.n} className="flex gap-4 py-5">
              <div className="w-7 h-7 rounded-full bg-[#EEEDFE] flex items-center justify-center text-xs font-medium text-[#534AB7] shrink-0 mt-0.5">
                {s.n}
              </div>
              <div>
                <h3 className="text-sm font-medium mb-1">{s.title}</h3>
                <p className="text-sm text-zinc-500 leading-relaxed">{s.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <hr className="border-zinc-100 max-w-5xl mx-auto" />

      {/* Features */}
      <section id="features" className="px-6 py-16 max-w-3xl mx-auto">
        <p className="text-xs font-medium text-[#534AB7] tracking-widest uppercase mb-3">Features</p>
        <h2 className="text-2xl font-medium tracking-tight mb-3">Built for how you actually text</h2>
        <p className="text-zinc-500 leading-relaxed mb-10">
          ConTxt adapts to your tone, schedule, and location — not the other way around.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map((f) => (
            <div key={f.title} className="border border-zinc-100 rounded-xl p-5">
              <div className="w-9 h-9 bg-[#EEEDFE] rounded-lg flex items-center justify-center text-lg mb-3">
                {f.icon}
              </div>
              <h3 className="text-sm font-medium mb-1">{f.title}</h3>
              <p className="text-sm text-zinc-500 leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Waitlist CTA */}
      <section id="waitlist" className="px-6 py-16">
        <div className="max-w-xl mx-auto bg-[#EEEDFE] rounded-2xl px-8 py-12 text-center">
          <h2 className="text-2xl font-medium tracking-tight mb-3">Be first to try ConTxt</h2>
          <p className="text-zinc-500 text-sm leading-relaxed mb-6">
            Android beta launching soon. Drop your email and we&apos;ll let you know.
          </p>
          <WaitlistForm />
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-100 px-6 py-6 flex flex-col sm:flex-row justify-between items-center gap-3 max-w-5xl mx-auto text-sm text-zinc-400">
        <span>© 2026 ConTxt</span>
        <div className="flex gap-5">
          <a href="/privacy" className="hover:text-zinc-600 transition-colors">Privacy</a>
          <a href="/terms" className="hover:text-zinc-600 transition-colors">Terms</a>
          <a href="mailto:hello@get-contxt.app" className="hover:text-zinc-600 transition-colors">Contact</a>
        </div>
      </footer>
    </div>
  );
}
