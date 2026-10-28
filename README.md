# luckyz-runner

아이폰 럭키즈 앱의 매일 코인 받기를 **GitHub Actions(맥 서버)** 에서 돌리는 개인용 자동화.
폰은 Tailscale 로 연결되어 있어 어느 Wi-Fi·데이터에서든 폰의 단축어 버튼 하나로 실행된다.

## 구조
- `run.mjs` — 시나리오(YAML) 실행기: 광고 넘기기, 퍼즐 풀기, 보유량 읽기·보고
- `wda.mjs` — Appium 없이 폰의 WebDriverAgent 에 HTTP 로 바로 붙는 드라이버 (`LUCKYZ_WDA_URL`)
- `lib.mjs` — 세션·로그 공통
- `puzzles/` — 스도쿠·퀸즈·시카쿠 풀이, 화면 글자 읽기(macOS Vision), 버튼 모양 찾기
- `.github/workflows/run.yml` — 실행 워크플로

## 필요한 비밀값 (Settings → Secrets and variables → Actions)
| 이름 | 내용 |
|---|---|
| `TS_AUTHKEY` | Tailscale 인증 키 (재사용·임시 노드) |
| `LUCKYZ_WDA_URL` | `http://<폰 Tailscale IP>:8100` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` 결과 (광고 버튼 판단) |
| `NTFY_TOPIC` (선택) | 끝나면 ntfy 앱으로 결과 알림 |

## 제약
- 폰의 WebDriverAgent 는 맥에서 케이블로 한 번 켜야 한다 (폰 재부팅 후마다).
- 실행 기록·스크린샷은 공개하지 않는다 (Actions 캐시에만 보관).
