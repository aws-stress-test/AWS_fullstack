/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(process.env.NODE_ENV === 'production' && {
    assetPrefix: 'https://d23o64gsxtgwu6.cloudfront.net/'
  })
};

module.exports = nextConfig;
