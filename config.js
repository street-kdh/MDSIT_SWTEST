// MDS인텔리전스 사전인터뷰 · API 서버 설정
//
// GitHub Pages에서 서비스할 때:
//   아래 apiBase를 Tailscale 서버 주소로 설정
//
// 로컬에서 직접 실행할 때:
//   apiBase를 '' (빈 문자열) 로 설정하면 상대경로 사용
//
window.INTERVIEW_CONFIG = {
    apiBase: 'https://placelog-server.tail484942.ts.net:8443'
};
