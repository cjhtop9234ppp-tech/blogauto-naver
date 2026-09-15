# 백업·복구·GitHub 운영

## 백업 대상

프로그램 소스와 사용자 런타임은 분리해 백업합니다.

```text
소스: blogauto-naver/src, package.json, package-lock.json, scripts, README
사용자 데이터: %APPDATA%\blogauto-naver-tistory\runtime
```

runtime에는 계정 선택, 카테고리, 이력, 초안, 이미지, 복구 기록, Chrome 세션이 있으므로 공개 저장소에 올리지 않습니다.

## 복구 순서

1. 정확한 프로젝트 경로를 확인합니다.
2. 새 설치파일을 별도 폴더에서 검증합니다.
3. 기존 runtime을 바로 덮어쓰지 않고 백업합니다.
4. 새 프로그램의 userData/runtime 경로가 기존과 같은지 확인합니다.
5. 계정·이력·작업 체크포인트를 읽기 전용으로 확인합니다.
6. 필요한 경우에만 사용자 승인 후 교체합니다.

## GitHub 현재 상태

현재 원격은 다음으로 확인되었습니다.

```text
https://github.com/boksajang/blogauto-naver.git
```

현재 작업 트리에는 수정 파일과 여러 미추적 `dist-*` 산출물이 있습니다. 따라서 push 전에는 변경 범위를 먼저 분리해야 하며, 강제 push나 기존 history 삭제를 하지 않습니다.

## 공개 전 검사

- `.env`, 비밀번호, Cookie, Session, Token 제외
- `runtime/`, `dist/`, `node_modules/`, `*.log` 제외
- 네이버·온새카 개인 데이터와 내부 프롬프트 공개 범위 검토
- README·설치법·스크린샷·LICENSE 확인
- portable/Setup 산출물의 실제 버전·해시 확인
- `npm run check`, `npm run check:file-parser` 실행

현재는 공개/비공개 선택과 push 승인이 없으므로 GitHub push 및 Release 생성은 수행하지 않았습니다.
