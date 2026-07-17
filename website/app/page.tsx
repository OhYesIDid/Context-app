import WaitlistForm from "./components/WaitlistForm";
import ParticleBackground from "./components/ParticleBackground";
import AndroidBubbleDemo from "./components/AndroidBubbleDemo";

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

const signals = [
  {
    icon: "📅",
    title: "Calendar",
    body: "Checks your Google Calendar free/busy before answering scheduling questions — never reads event details, just yes or no.",
  },
  {
    icon: "📍",
    title: "Live location",
    body: "Estimates ETA via Google Maps the moment a message asks where you are. Used once, then gone.",
  },
  {
    icon: "✈️",
    title: "Trip & booking awareness",
    body: "Finds flight, hotel, and reservation confirmations in Gmail so travel questions get the right dates.",
  },
  {
    icon: "💬",
    title: "Conversation history",
    body: "Reads back through the recent thread so a reply doesn't ignore context you already gave.",
  },
  {
    icon: "🧠",
    title: "Style learning",
    body: "Learns from the edits you make to suggestions over time — replies drift closer to how you actually text, per contact.",
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
    icon: "✈️",
    title: "Trip-aware",
    body: "Finds your flight, hotel, and reservation confirmations to answer travel questions with the right dates.",
  },
  {
    icon: "🧠",
    title: "Learns your style",
    body: "Picks up on the edits you make and gets closer to how you actually text.",
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

const plans = [
  {
    name: "Free",
    tagline: "Everything you need for the moments that matter",
    items: [
      "Reply suggestions for ETA, availability, and plans",
      "Calendar, location, and trip-aware replies",
      "Brief, casual, and formal tone options",
      "Works across WhatsApp, iMessage, Telegram, and more",
    ],
    cta: "Get early access",
    highlight: false,
  },
  {
    name: "Pro",
    tagline: "Reply smarter, to every message",
    items: [
      "Suggestions for every incoming message — not just ETA, availability, or plans",
      "Deeper style learning across all your contacts",
      "First access to new Pro features",
    ],
    cta: "Join the waitlist",
    highlight: true,
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
            <a href="#pricing" className="text-sm text-white/50 hover:text-white transition-colors hidden sm:block">
              Pricing
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

      {/* Android bubble demo */}
      <div className="relative z-10 max-w-xs mx-auto mb-20">
        <AndroidBubbleDemo />
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

      {/* How it thinks */}
      <section id="how-it-thinks" className="px-6 py-16 max-w-2xl mx-auto">
        <p className="text-xs font-medium text-[#534AB7] tracking-widest uppercase mb-3">How it thinks</p>
        <h2 className="text-2xl font-medium tracking-tight mb-3">Context, not guesswork</h2>
        <p className="text-zinc-500 leading-relaxed mb-10">
          Every reply is backed by real signals ConTxt actually checks — not a generic AI guess dressed up to sound confident.
        </p>
        <div className="divide-y divide-zinc-100">
          {signals.map((s) => (
            <div key={s.title} className="flex gap-4 py-5">
              <div className="w-9 h-9 rounded-lg bg-[#EEEDFE] flex items-center justify-center text-lg shrink-0">
                {s.icon}
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
      <section id="features" className="px-6 py-16 max-w-4xl mx-auto">
        <p className="text-xs font-medium text-[#534AB7] tracking-widest uppercase mb-3">Features</p>
        <h2 className="text-2xl font-medium tracking-tight mb-3">Built for how you actually text</h2>
        <p className="text-zinc-500 leading-relaxed mb-10">
          ConTxt adapts to your tone, schedule, location, and plans — not the other way around.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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

      <hr className="border-zinc-100 max-w-5xl mx-auto" />

      {/* Pricing */}
      <section id="pricing" className="px-6 py-16 max-w-4xl mx-auto">
        <p className="text-xs font-medium text-[#534AB7] tracking-widest uppercase mb-3">Pricing</p>
        <h2 className="text-2xl font-medium tracking-tight mb-3">Free to start, upgrade when you want more</h2>
        <p className="text-zinc-500 leading-relaxed mb-10">
          The core experience is free. Pro unlocks suggestions on every message, not just the ones ConTxt recognizes as ETA, availability, or plans.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {plans.map((p) => (
            <div
              key={p.name}
              className={`rounded-2xl p-6 border ${
                p.highlight ? "bg-[#0f0d1f] border-[#0f0d1f]" : "border-zinc-100"
              }`}
            >
              <h3 className={`text-lg font-medium mb-1 ${p.highlight ? "text-white" : "text-zinc-900"}`}>
                {p.name}
              </h3>
              <p className={`text-sm mb-5 ${p.highlight ? "text-white/50" : "text-zinc-500"}`}>{p.tagline}</p>
              <ul className="space-y-2.5 mb-6">
                {p.items.map((item) => (
                  <li key={item} className={`flex gap-2 text-sm leading-relaxed ${p.highlight ? "text-white/80" : "text-zinc-600"}`}>
                    <span className={p.highlight ? "text-[#AFA9EC]" : "text-[#534AB7]"}>✓</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <a
                href="#waitlist"
                className={`block text-center text-sm font-medium px-4 py-2.5 rounded-lg transition-colors ${
                  p.highlight
                    ? "bg-[#534AB7] text-white hover:bg-[#3C3489]"
                    : "border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                }`}
              >
                {p.cta}
              </a>
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
