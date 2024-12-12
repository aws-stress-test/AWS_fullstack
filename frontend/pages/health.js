export default function Health() {
    return null;  // 자동으로 200 상태코드 반환
}

// getServerSideProps를 사용하여 서버 사이드에서 응답 헤더와 상태를 제어
export async function getServerSideProps({ res }) {
    // 캐시 방지를 위한 헤더 설정
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // 200 상태 코드와 JSON 응답 반환
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));

    return {
        props: {},
    };
}