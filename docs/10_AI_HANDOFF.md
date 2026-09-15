# AI HANDOFF

## 프로젝트 목적

Windows Electron 프로그램으로 원본 파일 또는 검색 자료를 바탕으로 네이버 블로그 초안을 만들고 사용자의 승인 후 발행합니다. 온새카 회원마당 수집·등록은 네이버 일반 작업과 별도 흐름입니다.

## 작업 시작 전 필수 확인

1. 현재 작업 경로가 정확히 `blogauto-naver`인지 확인합니다.
2. `git status`, `git remote -v`, 현재 branch를 읽기 전용으로 확인합니다.
3. 실행 중인 프로그램·Chrome·runtime을 종료하지 않습니다.
4. 사용자 runtime과 source `runtime`을 혼동하지 않습니다.
5. 비밀번호·토큰·Cookie를 읽거나 출력하지 않습니다.

## 절대 임의로 변경하지 않을 부분

- 네이버 수동 로그인 정책
- userData/runtime 경로와 기존 사용자 데이터
- 작업 ID와 선택 큐의 제목 검증
- 실패 시 브라우저 유지 정책
- `REVISION/BLOCK`을 근거 없이 발행하는 정책
- 회원마당과 네이버 발행의 기능 경계

## 수정 후 필수 검증

```powershell
npm run check
npm run check:file-parser
```

가능하면 별도 runtime/output에서 Electron smoke와 portable 빌드를 수행합니다. 라이브 발행 성공은 소스 검사만으로 선언하지 않습니다.

## 상태 해석

- `PASS`: 다음 단계로 진행 가능
- `REVISION`: 수정 후 재검수 필요
- `BLOCK`: 근거 또는 필수 자료 부족으로 발행 금지
- `DRY_RUN`: 생성만 완료
- `failed`: 오류 기록, 재개·재생성 가능성 확인
- `success`: 발행 완료 또는 사용자가 수동 발행으로 표시

## 사용자에게 보고할 때

확인한 사실, 추정, 확인 필요를 분리합니다. 빌드 성공과 설치·로그인·실제 발행 성공을 같은 의미로 보고하지 않습니다.
