/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The dashboard is read-only and calls the agent API directly from the
  // browser, so there is no rewrite/proxy layer here: the base URL is public
  // config (NEXT_PUBLIC_API_BASE_URL) and the agent enables CORS. A proxy would
  // hide which host answered, and this product's whole claim is that a reader
  // can see where a number came from.
  poweredByHeader: false,
};

export default nextConfig;
