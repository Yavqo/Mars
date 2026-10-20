/** Shown only on localhost, in the AI overview's place, while no OpenRouter key is set. Nobody else ever sees it. */
export function OverviewSetup() {
  return (
    <section className="ov ov-setup" aria-label="AI overview setup">
      <header className="ov-head"><span className="ov-badge">AI overview is off</span></header>
      <p className="ov-setup-text">
        Add your OpenRouter key to <code>.env.local</code> and the overview appears here, above the results:
      </p>
      <pre className="ov-setup-code">OPENROUTER_API_KEY=your-key-here</pre>
      <p className="ov-note">Get a key at openrouter.ai/keys, then restart <code>npm run dev</code>. Only you see this message, and only on localhost.</p>
    </section>
  );
}
