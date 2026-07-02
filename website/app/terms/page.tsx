export default function Terms() {
  return (
    <div className="min-h-screen">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-zinc-100 max-w-5xl mx-auto">
        <a href="/" className="text-lg font-medium tracking-tight">
          Con<span className="text-[#534AB7]">Txt</span>
        </a>
      </nav>

      <article className="max-w-2xl mx-auto px-6 py-16 prose prose-zinc">
        <h1 className="text-3xl font-medium tracking-tight mb-2">Terms of Service</h1>
        <p className="text-sm text-zinc-400 mb-10">Last updated: June 2026</p>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">Acceptance</h2>
          <p className="text-zinc-600 leading-relaxed">
            By using ConTxt you agree to these terms. If you don't agree, don't use the app.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">Beta software</h2>
          <p className="text-zinc-600 leading-relaxed">
            ConTxt is currently in beta. Features may change, break, or be removed at any time.
            We make no guarantee of uptime or continued availability during this period.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">What ConTxt does</h2>
          <p className="text-zinc-600 leading-relaxed">
            ConTxt reads notification content on your device and uses it to generate reply
            suggestions via a third-party AI service. You remain fully responsible for any message
            you choose to send. ConTxt does not send messages on your behalf without your explicit
            action.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">Acceptable use</h2>
          <p className="text-zinc-600 leading-relaxed">
            You may not use ConTxt to generate or send harassing, abusive, or unlawful messages.
            You may not reverse-engineer, decompile, or attempt to extract source code from the app.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">Disclaimer of warranties</h2>
          <p className="text-zinc-600 leading-relaxed">
            ConTxt is provided "as is" without warranties of any kind. AI-generated suggestions may
            be inaccurate, inappropriate, or incomplete. Always review a reply before sending it.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">Limitation of liability</h2>
          <p className="text-zinc-600 leading-relaxed">
            To the maximum extent permitted by law, ConTxt and its creators are not liable for any
            damages arising from your use of the app or any messages sent using its suggestions.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">Changes</h2>
          <p className="text-zinc-600 leading-relaxed">
            We may update these terms at any time. Continued use of ConTxt after changes are posted
            constitutes acceptance of the updated terms.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">Contact</h2>
          <p className="text-zinc-600 leading-relaxed">
            Questions? Email{" "}
            <a href="mailto:hello@get-contxt.app" className="text-[#534AB7] hover:underline">
              hello@get-contxt.app
            </a>.
          </p>
        </section>
      </article>

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
