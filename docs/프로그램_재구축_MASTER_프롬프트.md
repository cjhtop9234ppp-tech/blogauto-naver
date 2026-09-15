# [MASTER] 네이버 블로그 자동화 프로그램 재구축 프롬프트

아래 프롬프트는 설치파일을 분실했거나 새 PC에서 프로그램을 다시 빌드해야 할 때 사용한다.

---

## 복사해서 사용할 프롬프트

```text
[MASTER] 네이버 블로그 자동화 프로그램 안전 재구축·검증·배포

현재 프로젝트는 네이버 블로그 자동화 Windows Electron 프로그램이다.
프로그램을 새로 만들거나 기존 기능을 임의로 바꾸는 것이 아니라, 보존된 소스코드와 문서를 근거로 기존 동작을 복원하고 검증한다.

==================================================
1. 프로젝트 위치
==================================================

정식 프로젝트 경로:
C:\Users\MYCOM\Documents\ChatGPT\네이버 블로그 자동화(Codex 프로그램 소스코드)\blogauto-naver

먼저 반드시 다음을 읽는다.

- docs\README_INDEX.md
- docs\00_프로젝트_한장요약.md
- docs\01_프로그램_전체구조.md
- docs\02_실행_FLOW.md
- docs\03_설치_및_실행방법.md
- docs\04_설정값_환경변수.md
- docs\05_오류_및_해결이력.md
- docs\06_유지보수_가이드.md
- docs\10_AI_HANDOFF.md
- docs\11_SKILL_역분석_MASTER.md

문서와 실제 소스코드가 다르면 실제 소스코드를 우선하고, 차이를 최종 보고서에 기록한다.

==================================================
2. 절대 지켜야 하는 보존 규칙
==================================================

1. 현재 실행 중인 프로그램, Chrome, 네이버 발행 작업을 종료하지 않는다.
2. 사용자 runtime을 삭제·초기화·덮어쓰지 않는다.
3. 다음 사용자 데이터는 보존한다.

   %APPDATA%\blogauto-naver-tistory\runtime

4. 비밀번호, Cookie, Session, Token, API Key를 출력하거나 문서에 저장하지 않는다.
5. 기존 소스 변경사항, 커밋, 브랜치, 원격 저장소를 임의로 삭제하지 않는다.
6. git reset --hard, 강제 push, 광범위한 삭제를 실행하지 않는다.
7. 기존 설치파일을 바로 덮어쓰지 말고 별도 출력 폴더에 빌드한다.
8. 기능이 실제 소스에 없으면 구현된 것으로 보고하지 않는다.
9. 테스트용 runtime과 사용자 runtime을 반드시 분리한다.

==================================================
3. 먼저 실행할 읽기 전용 점검
==================================================

프로젝트 경로에서 다음을 확인한다.

```powershell
Set-Location 'C:\Users\MYCOM\Documents\ChatGPT\네이버 블로그 자동화(Codex 프로그램 소스코드)\blogauto-naver'
Get-ChildItem -Force
git status --short --branch
git remote -v
Get-Content .\package.json -Raw
Get-Content .\.gitignore -Raw
```

확인 항목:

- 프로젝트 경로가 정확한가
- package.json의 버전과 build target은 무엇인가
- src 폴더와 scripts 폴더가 존재하는가
- 기존 변경사항이 있는가
- 원격 저장소가 예상한 저장소와 일치하는가
- runtime과 dist가 공개 대상에서 제외되어 있는가
- 설치파일 또는 portable EXE가 이미 있는가

==================================================
4. 실제 기능 요구사항
==================================================

다음 기능을 실제 코드와 문서에 존재하는 범위에서 보존한다.

### 일반 글 생성

- 수동 주제 입력
- 웹 검색 기반 생성
- TXT, MD, PDF, DOCX, XLSX, XLS, CSV, PPTX 원본 업로드
- 파일 내용 추출과 표 구조 처리
- Research/Title Agent
- Writer Agent
- Main Review Agent
- Image Worker
- 제목·본문·태그·이미지 Preview
- DRY_RUN 기본 생성
- 검수 PASS 후 발행

### 네이버 블로그 발행

- 계정별 Blog ID와 카테고리 관리
- 계정별 Chrome 로그인 세션 재사용
- 네이버 비밀번호 자동 저장·자동 입력 금지
- 제목·본문·이미지 입력
- 공개·비공개·예약 설정
- 실제 블로그 카테고리 확인
- 태그 입력은 선택 기능으로 처리
- 첫 발행 설정 버튼과 최종 발행 버튼 처리
- 발행 완료 신호 확인
- 오류 발생 시 브라우저 유지

### 작업 이력

- 최근 이력 표시
- 전체/DRY_RUN/실패/성공 필터
- 같은 제목의 오래된 기록 제거
- 본문 불러오기
- 선택 글 자동 발행
- 선택 원인 분석·재발행
- 선택 항목 성공 처리
- 발행 카테고리 일괄 적용
- 선택 이력 삭제
- 선택 큐의 job ID와 제목 일치 검증

### 복구

- Research, Writer, Main Review, Image 단계별 체크포인트 저장
- job-input.json 저장
- job-checkpoint.json 저장
- agent-result.json 저장
- 이미지별 progress 저장
- 오류 해결 프롬프트 입력
- 중단 지점부터 재개
- 완료된 결과 재사용
- 실패 시 처음부터 무조건 다시 시작하지 않기

### 회원마당·일일 작업

- 온새카 회원마당 로그인 세션 확인
- 회원마당 게시글 수집
- 9개 분류 슬롯 계획
- 초안 생성
- 항목별 승인
- 승인 항목 네이버 발행
- 랜덤 주제 단건 실행 및 온새카 등록
- Windows 스케줄러 09:00/10:30/12:00 처리

주의: 회원마당 수집형 일일 흐름과 9개 카테고리 웹 검색형 일일 흐름은 서로 다를 수 있다. 실제 코드에 없는 웹 검색형 배치를 임의로 추가하지 않는다.

==================================================
5. 실제 주요 파일
==================================================

- src\main.js: Electron main process, IPC, 작업 오케스트레이션
- src\preload.js: renderer용 window.blogAuto API
- src\renderer\index.html: UI 구조
- src\renderer\app.js: UI 상태·버튼·작업 이력·Preview
- src\renderer\styles.css: UI 스타일
- src\lib\settings.js: 설정 기본값·정규화·저장
- src\lib\accountStore.js: 계정·카테고리 저장
- src\lib\codexRunner.js: 에이전트 실행·프롬프트·timeout
- src\lib\search.js: Naver/Google 검색·근거 품질
- src\lib\fileParser.js: 원본 파일 파싱
- src\lib\imageAssets.js: 이미지 자산 정규화
- src\lib\history.js: 작업 이력 JSONL 저장·상태 변경
- src\lib\naverPublisher.js: 네이버 SmartEditor 자동화
- src\lib\tistoryPublisher.js: Tistory 자동화
- src\lib\dailyWorkflow.js: 회원마당 일일 계획·9개 슬롯
- src\lib\memberBoardCrawler.js: 회원마당·블로그 수집
- src\lib\memberBoardPublisher.js: 회원마당 등록
- src\lib\recoveryPlaybook.js: 복구 해결책·시도 기록
- src\lib\windowsScheduler.js: Windows 스케줄러
- src\lib\register-scheduler.ps1: 스케줄러 보조 스크립트

==================================================
6. 실행·빌드 명령
==================================================

개발 실행:

```powershell
npm install
npm start
```

검사:

```powershell
npm run check
npm run check:file-parser
```

기본 portable 빌드:

```powershell
npm run dist
```

기존 dist를 보호하기 위한 별도 검증 빌드:

```powershell
npm exec electron-builder -- --win portable --config.directories.output=dist-rebuild-audit
```

현재 package.json 기준 공식 재현 target은 Windows portable이다. 과거 Setup.exe가 존재하더라도 현재 최신 설치파일이라고 단정하지 않는다.

==================================================
7. 복구할 사용자 데이터
==================================================

다음 파일을 새 설치파일과 혼동하지 않는다.

```text
%APPDATA%\blogauto-naver-tistory\runtime\user-settings.json
%APPDATA%\blogauto-naver-tistory\runtime\account-categories.json
%APPDATA%\blogauto-naver-tistory\runtime\blog_history.jsonl
%APPDATA%\blogauto-naver-tistory\runtime\jobs\
%APPDATA%\blogauto-naver-tistory\runtime\browser-profiles\
%APPDATA%\blogauto-naver-tistory\runtime\member-board-daily-plan.json
```

설치파일을 다시 만들어도 이 runtime을 자동으로 삭제하지 않는다. 새 프로그램이 같은 userData/runtime을 사용하는지 확인한다.

==================================================
8. 검증 절차
==================================================

### 정적 검사

- JavaScript 전체 문법 검사
- package.json과 의존성 확인
- IPC와 preload API 연결 확인
- 파일 파서 검사
- 지원 확장자 검사
- timeout과 checkpoint 로직 검사
- history 선택 큐의 job ID/title 검증 검사

### UI 검사

- 프로그램 제목과 주요 UI 존재
- 계정·카테고리 화면
- 원본 파일 업로드·삭제
- Preview
- 작업 이력 필터·선택·일괄 버튼
- 오류 해결 프롬프트와 재개 버튼
- 중앙 패널 스크롤

### 발행 검사

- 실제 네이버 로그인은 사용자가 직접 수행
- 테스트 글 또는 사용자 승인 글 1건으로 검증
- 카테고리 선택 결과 확인
- 공개설정 확인
- 첫 발행 버튼과 최종 발행 버튼 확인
- 완료 URL·알림·상태 확인
- 실제 발행 성공 전에는 PASS라고 보고하지 않음

### 복구 검사

- research 단계 실패 후 research부터 재개
- writer 단계 실패 후 writer부터 재개
- main_review 단계 실패 후 main_review부터 재개
- image 단계 실패 후 완료 이미지 재사용
- 한 일괄 항목 실패 후 다음 항목 큐가 잘못된 초안으로 바뀌지 않는지 확인

==================================================
9. 설치파일 검증과 해시
==================================================

빌드 후 반드시 다음을 기록한다.

```powershell
Get-ChildItem .\dist-rebuild-audit -Recurse -File
Get-FileHash -Algorithm SHA256 .\dist-rebuild-audit\Naver-Blog-Automator-0.1.0.exe
```

다음 정보를 함께 보고한다.

- 파일명
- 절대 경로
- 파일 크기
- 생성 시각
- SHA-256
- 빌드에 사용한 commit 또는 작업 트리 상태
- 검사 결과

==================================================
10. GitHub 처리 규칙
==================================================

push 전 반드시 사용자에게 다음을 확인한다.

- Public 또는 Private 여부
- push할 branch
- 기존 변경사항을 포함할지 여부
- 설치파일을 Release Asset으로 올릴지 여부

승인 전에는 push, Release 생성, 기존 파일 삭제를 하지 않는다.
강제 push와 기존 Git history 삭제는 금지한다.

==================================================
11. 최종 보고 형식
==================================================

다음 형식을 지켜 결과를 보고한다.

```text
PROJECT =
LOCAL_PATH =
VERSION =
BRANCH =
REMOTE =

SOURCE_CHECK = PASS / FAIL / PARTIAL
FLOW_CHECK = PASS / FAIL / PARTIAL
FILE_PARSER_CHECK = PASS / FAIL / PARTIAL
UI_CHECK = PASS / FAIL / PARTIAL
RECOVERY_CHECK = PASS / FAIL / PARTIAL
BUILD_CHECK = PASS / FAIL / PARTIAL
INSTALL_CHECK = PASS / FAIL / PARTIAL
SECURITY_CHECK = PASS / FAIL / PARTIAL

INSTALLER_PATH =
INSTALLER_SHA256 =
GITHUB_PUSH = NOT_REQUESTED / COMPLETED / BLOCKED
RELEASE = NOT_REQUESTED / COMPLETED / BLOCKED

KNOWN_LIMITATIONS =
FINAL_STATUS = SUCCESS / PARTIAL / FAIL
```

문서·소스·검사만 완료된 경우 `FINAL_STATUS = PARTIAL`로 표시한다. 새 PC 설치, 로그인, 실제 네이버 발행, GitHub Release를 확인하지 않았다면 `SUCCESS`로 보고하지 않는다.
```

---

## 복구 핵심 요약

```text
설치파일 분실
→ 정확한 소스 경로 확인
→ 문서·package.json 확인
→ npm install
→ npm run check
→ 별도 폴더 portable 빌드
→ SHA-256 기록
→ 새 PC에서 설치·로그인·발행 검증
```

이 문서는 프로그램을 설명하는 문서가 아니라, 프로그램을 다시 빌드하고 검증하기 위한 실행용 프롬프트입니다.
