import Document, { Html, Head, Main, NextScript } from "next/document";

class MyDocument extends Document {
  render() {
    return (
      <Html lang="ko">
        <Head>
          <meta charSet="utf-8" />
          <link
            rel="preload"
            href="https://statics.goorm.io/gds/foundation/v0.19.0/vapor-foundation.dark.min.css"
            as="style"
          />
          <link
            rel="stylesheet"
            href="https://statics.goorm.io/gds/foundation/v0.19.0/vapor-foundation.dark.min.css"
          />
        </Head>
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}

export default MyDocument;
