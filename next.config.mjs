/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The AI overview reads its system prompt from prompts.txt at run time, so the file has to ship with the route.
  outputFileTracingIncludes: { "/api/overview": ["./prompts.txt"] },
};
export default nextConfig;
