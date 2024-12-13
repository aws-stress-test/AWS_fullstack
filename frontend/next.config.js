/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  ...(process.env.NODE_ENV === 'production' && {
    assetPrefix: 'https://d23o64gsxtgwu6.cloudfront.net/'
  })
};

module.exports = nextConfig;
