# JewelViewer — Rhino 8 렌더러 플러그인

Rhino 8(Windows) 도킹 패널에 웹 뷰어(`/viewer-live`)를 WebView2로 띄워 현재 문서를 실시간으로 보여 준다.
보이는 객체를 독립 실행 HTML·EXE로 내보내 Rhino 없이도 볼 수 있다.

## 빌드

repo 루트에서 순서대로 실행한다. 필요한 것: .NET 7 이상 SDK(플러그인 타깃은 net7.0), Node·pnpm, WebView2 Runtime.

```powershell
pnpm install
pnpm build:shell                                         # out/ + dist/jewelviewer-shell.html + dist/plugin-web/
dotnet build viewerhost\JewelViewerHost.csproj -c Release  # EXE 내보내기 템플릿
dotnet run --project plugin-tests\PluginTests.csproj
dotnet build plugin\JewelViewer.csproj -c Release          # 웹·셸·EXE를 ZIP으로 묶어 rhp에 임베드
```

`build:shell`은 패널용 웹 자산에서 전체 `model/`·`rhino3dm/`을 제외하고 뷰어 설정의 HDR·그림자 텍스처만 넣는다. 라이브/내보내기에서 쓰지 않는 샘플 3dm은 제외한다.
플러그인 빌드는 웹 자산·셸·Release EXE 템플릿 중 하나라도 없으면 선행 빌드 안내와 함께 실패한다.
입력 변경·추가·삭제가 없으면 ZIP을 다시 만들지 않으며 설계 시점 빌드에서는 묶지 않는다.
개발용 플러그인은 `-c Debug`로 빌드한다. 변경된 rhp를 Rhino가 로드한 상태면 MSB3027(파일 잠김)로 실패하므로 Rhino를 닫고 다시 빌드한다.

## 설치

`plugin\bin\Release\net7.0\JewelViewer.rhp` **하나만** 배포한다. 원하는 폴더에 놓고 Rhino 창에 끌어다 놓는다(또는 `PlugInManager` → Install).
웹 폴더·셸 HTML·EXE 템플릿을 옆에 둘 필요가 없다. 업데이트한 rhp는 Rhino를 재시작할 때 로드된다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `JewelViewer` | 뷰어 패널을 연다. 처음 열면 떠 있는 창으로 나오며, 끌어서 도킹할 수 있다 |
| `JewelViewerExport` | 보이는 선택(없으면 보이는 전체)을 `.html` 또는 `.exe`로 내보낸다. 저장 대화상자에서 확장자를 고른다 |
| `JewelViewerCameraSync` | Rhino 뷰포트 카메라 따라가기를 켜고 끈다 |
| `JewelViewerSync` | 캐시를 비우고 보이는 전체를 다시 동기화한다 |
| `JewelViewerDiagnostics` | 웹 루트·포트·WebView2·페이지 상태를 명령줄에 찍는다 |

객체 재질은 Rhino의 객체 지정·레이어 지정·블록 부모 상속 규칙으로 읽는다. 이름으로 분류하지 않는다.

- 재질 없음 → 웹 설정의 플래티넘
- Gem 프리셋 6종(diamond·ruby·sapphire·emerald·amethyst·aquamarine) → 보석 렌더러, 색·굴절률 반영
- 그 밖의 재질(Metal·플라스틱·페인트·유리·PBR 등) → 색·금속성·거칠기 등을 반영한 일반 재질, 투명은 투과
- 프롱도 입힌 재질대로 표시하며, 조명·반사 환경·톤은 웹 뷰어 설정을 유지한다.
- 재질 편집·지정 변경은 패널에 반영되고 HTML·EXE 내보내기도 같은 재질 표를 쓴다.
- 일반 재질의 기본색(PBR BaseColor·Custom 확산) 슬롯에 걸린 이미지 파일 텍스처(PNG·JPEG·WebP·GIF·BMP)는 매핑 채널 1의 렌더 메시 UV와 반복·오프셋·회전으로 입힌다. 큰 이미지는 뷰어에서 긴 변 2048로 줄인다.
- 절차 텍스처(대리석 생성 등)·그 밖의 이미지 형식·보석 재질의 텍스처는 반영하지 않고 색만 쓴다.
- 객체별 사용자 매핑(평면·박스 등)은 반영하지 않는다. 그런 객체도 렌더 메시 자체 UV(서피스 매개변수)로 입힌다.
- 카보숑·진주 등 둥근 보석은 오브젝트 사용자 텍스트 `jewelviewer.smooth=1`을 붙이면 렌더 메시 정점 법선으로 매끈하게 그린다. 값은 `1`·`true`·`yes`(대소문자 무시)이고, 블록은 인스턴스나 정의 안 오브젝트 어느 쪽에 붙여도 된다. 태그가 없거나 다른 값인 보석은 면마다 각지게 그린다.
- 면별(sub-object) 재질·범프는 지원하지 않는다.

## 동작 메모

- 패널은 화면에 처음 보일 때 WebView2·로컬 서버(127.0.0.1, 임의 포트)를 시작한다.
  창 없는(headless)·창을 숨긴 RhinoCore 호스트에서는 시작하지 않는다.
- 문서를 저장하지 않아도 된다. 변경된 객체만 메시로 만들어 메모리에서 서빙하고, 메싱·압축은 백그라운드에서 한다.
- 기본 웹 화면은 rhp의 ZIP 리소스를 패널 시작 시 메모리로 풀어 서빙한다. 임베드 자산 누락·손상은 패널에 오류로 표시한다.
- 개발할 때만 환경변수 `JEWELVIEWER_WEBROOT`를 `viewer-live/index.html`이 있는 유효한 웹 빌드 폴더(예: repo의 `out/`)로 지정하면 디스크에서 서빙한다.
  웹을 다시 빌드한 뒤 패널을 새로 고치면 rhp 재빌드 없이 확인할 수 있다. 변수는 Rhino 시작 전에 설정하며, 없거나 폴더가 유효하지 않으면 임베드 자산을 쓴다.
- HTML 셸과 EXE 템플릿은 항상 임베드에서 읽는다. 웹 루트 환경변수와 무관하며 패널·서버를 열지 않아도 내보낼 수 있다.
- 내보낸 EXE는 Windows x64 + WebView2 Runtime에서 단독 실행된다(`viewerhost\README.md`).
