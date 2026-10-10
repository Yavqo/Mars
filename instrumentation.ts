/**
 * Runs once when the server starts. The first visitor should not pay for waking things up: the database (a serverless
 * database sleeps when idle) and, in development, compiling the pages (Next compiles each page the first time it is opened).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { warmUp } = await import("./instrumentation-node");
    await warmUp();
  }
}
