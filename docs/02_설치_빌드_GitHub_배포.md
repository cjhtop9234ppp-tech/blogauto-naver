# 설치·빌드·GitHub 배포 가이드

## 1. 현재 프로젝트 정보

```text
프로젝트: blogauto-naver
패키지 버전: 0.1.0
실행 기술: Electron
Windows 빌드: electron-builder portable
원격 저장소: https://github.com/boksajang/blogauto-naver.git
```

## 2. 개발 환경 실행

```powershell
Set-Location 'C:\Users\MYCOM\Documents\ChatGPT\네이버 블로그 자동화(Codex 프로그램 소스코드)\blogauto-naver'
npm install
npm start
```

## 3. 검사와 빌드

```powershell
npm run check
npm run check:file-parser
npm run dist
```

`npm run dist`는 `electron-builder --win portable`로 `dist/`에 실행파일을 생성하고 runtime 기본 폴더를 준비합니다. 현재 package 설정의 재현 가능한 공식 target은 portable입니다. 과거 `Setup.exe` 파일이 폴더에 남아 있어도 그것이 현재 최신 빌드라는 뜻은 아닙니다.

## 4. 사용자 설치·최초 실행

1. portable 실행파일을 별도 폴더에 보관합니다.
2. 프로그램을 실행합니다.
3. 계정에 Blog ID와 카테고리를 등록합니다.
4. 네이버 Chrome 창에서 사용자가 직접 로그인·보안 확인을 합니다.
5. 파일 업로드 또는 검색 입력을 선택합니다.
6. Preview와 Main 검수 결과를 확인합니다.
7. 승인 후 네이버 발행을 실행합니다.

## 5. 사용자 데이터

패키지 실행의 기본 runtime은 다음 위치입니다.

```text
%APPDATA%\blogauto-naver-tistory\runtime
```

계정·이력·초안·이미지·브라우저 세션이 이 경로에 있으므로 설치파일을 교체하기 전에 해당 폴더를 백업합니다. 실행파일마다 userData 경로가 달라지면 계정이 사라진 것처럼 보일 수 있습니다.

## 6. GitHub 공개 전 검사

- `runtime/`, `dist/`, `node_modules/`, `*.log` 제외
- `.env`, 비밀번호, Cookie, Session, Token, API Key 제외
- 개인 게시글 원문·계정 데이터·브라우저 프로필 제외
- README·LICENSE·설치 방법·스크린샷 확인
- 소스 문법·파일 파서·빌드 검사
- portable 실행파일의 버전·commit·SHA-256 기록

`.gitignore`에는 사용자 runtime, 계정 설정, browser profiles, 환경파일, 로그, 빌드 산출물이 제외되어 있습니다. 단, 현재 작업 트리에 과거 `dist-*` 폴더가 여러 개 있으므로 push 전에 미추적 파일을 수동 검토해야 합니다.

## 7. 현재 배포 검증 결과

```text
문법·계약 검사: PASS
파일 파서 검사: PASS
별도 portable 빌드: PASS
새 PC 설치·로그인·실제 Naver 발행: 미검증
Electron GUI smoke: 환경의 GUI 프로세스 제어 제한으로 PARTIAL
GitHub push/Release: 공개 범위 결정 전 보류
```

## 8. GitHub 운영 원칙

기존 저장소를 삭제하거나 강제 push하지 않습니다. 현재 작업 트리에 기존 수정사항이 있으므로 `git status`와 원격을 확인한 뒤, 문서·소스·배포파일을 구분해 commit합니다. 저장소를 Public으로 할지 Private으로 할지는 내부 프롬프트·자동발행 로직 공개 여부를 검토해 결정합니다.

