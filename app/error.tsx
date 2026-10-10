"use client";

import { useEffect } from "react";

/** If something in a page fails in the browser, show this instead of a blank crash. */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="error-page">
      <h1>Something went wrong</h1>
      <p className="lead">This page hit an error. Your search was not lost.</p>
      <div className="error-actions">
        <button className="btn btn-primary" onClick={reset}>Try again</button>
        <a className="btn btn-outline" href="/">Back to start</a>
      </div>
    </main>
  );
}
