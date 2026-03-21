import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
