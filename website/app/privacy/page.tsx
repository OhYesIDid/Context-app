export default function Privacy() {
  return (
    <div className="min-h-screen">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-zinc-100 max-w-5xl mx-auto">
        <a href="/" className="text-lg font-medium tracking-tight">
          Con<span className="text-[#534AB7]">Txt</span>
        </a>
      </nav>

      <article className="max-w-2xl mx-auto px-6 py-16 prose prose-zinc">
        <h1 className="text-3xl font-medium tracking-tight mb-2">Privacy Policy</h1>
        <p className="text-sm text-zinc-400 mb-10">Last updated: July 2026</p>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">What we collect</h2>
          <p className="text-zinc-600 leading-relaxed">
            When you join the waitlist we collect your email address. That's it. We use it to notify
            you when early access opens and to send occasional product updates.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">What the app accesses</h2>
          <p className="text-zinc-600 leading-relaxed mb-3">
            ConTxt requests the following permissions on your device:
          </p>
          <ul className="list-disc pl-5 text-zinc-600 leading-relaxed space-y-1">
            <li><strong>Notification access</strong> — to read incoming message text so we can generate a reply suggestion. No message content is stored on our servers.</li>
            <li><strong>Location</strong> — to estimate your ETA when a message asks where you are. Used only at the moment a suggestion is generated, never stored.</li>
            <li><strong>Calendar read</strong> — to check your availability when scheduling questions arise. Read-only, never modified.</li>
            <li><strong>Contacts</strong> — to match incoming messages to the right person in your address book, so replies and saved tone preferences apply to the correct contact. Contact data stays on your device.</li>
            <li><strong>Gmail read access</strong> — to find booking confirmations (flights, hotels, restaurants, events) so ConTxt can answer travel and availability questions with the right dates. Read-only; we search for confirmation emails and never send, delete, or modify anything in your inbox.</li>
            <li><strong>Display over other apps</strong> — to show a reply bubble on top of your messaging app so you can respond without switching away. No data is collected via this permission.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">What we store locally on your device</h2>
          <p className="text-zinc-600 leading-relaxed">
            ConTxt stores your app preferences (tone, monitored apps, saved places), a short history
            of reply edits, matched contacts, and booking details found in Gmail locally on your
            device to personalise future suggestions. This data never leaves your device unless you
            enable optional cloud sync.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">What we don't store on our servers</h2>
          <p className="text-zinc-600 leading-relaxed">
            Message content, location data, calendar events, contact details, and Gmail content are
            processed in real time to generate a reply or extract a booking date, and are never stored
            on our servers. Reply suggestions are ephemeral — once dismissed they are gone.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">Third-party services</h2>
          <p className="text-zinc-600 leading-relaxed mb-3">
            We use the following third-party services to power ConTxt:
          </p>
          <ul className="list-disc pl-5 text-zinc-600 leading-relaxed space-y-1">
            <li><strong>Anthropic (Claude)</strong> — generates reply suggestions from your message text. Subject to <a href="https://www.anthropic.com/privacy" className="text-[#534AB7] hover:underline" target="_blank" rel="noopener noreferrer">Anthropic's privacy policy</a>.</li>
            <li><strong>Google Maps Platform</strong> — estimates travel time for ETA replies. Your location is sent to Google only when an ETA suggestion is generated.</li>
            <li><strong>Google Calendar API</strong> — reads your calendar events to answer availability questions. Read-only access, revocable at any time.</li>
            <li><strong>Gmail API</strong> — read-only search for booking and reservation confirmation emails. Revocable at any time from your Google account settings.</li>
            <li><strong>Google People API</strong> — reads your Google contacts to help match senders to the right person. Read-only, revocable at any time.</li>
          </ul>
          <p className="text-zinc-600 leading-relaxed mt-3">We do not sell your data to any third party.</p>
          <p className="text-zinc-600 leading-relaxed mt-3">
            ConTxt&apos;s use and transfer of information received from Google APIs adheres to the{" "}
            <a href="https://developers.google.com/terms/api-services-user-data-policy" className="text-[#534AB7] hover:underline" target="_blank" rel="noopener noreferrer">
              Google API Services User Data Policy
            </a>, including the Limited Use requirements.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">Waitlist emails</h2>
          <p className="text-zinc-600 leading-relaxed">
            Waitlist email addresses are stored with Resend and used only to communicate about
            ConTxt. You can unsubscribe at any time using the link in any email we send.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">Your rights</h2>
          <p className="text-zinc-600 leading-relaxed">
            You can revoke any permission at any time via your device settings. To delete your account
            or request removal of any data we hold, email us at{" "}
            <a href="mailto:hello@get-contxt.app" className="text-[#534AB7] hover:underline">
              hello@get-contxt.app
            </a>.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-medium mb-3">Contact</h2>
          <p className="text-zinc-600 leading-relaxed">
            Questions? Email us at{" "}
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
