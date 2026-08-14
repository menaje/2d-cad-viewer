# 2D CAD Viewer for VS Code

VS Code 안에서 DWG 파일 형식의 도면을 빠르게 확인하고, 찾고, 측정하고,
내보낼 수 있는 오픈소스·로컬 우선 읽기 전용 2D CAD 뷰어입니다.

도면과 글꼴은 사용자의 컴퓨터 안에서만 처리됩니다. 대형 도면, 국내
SHX/BigFont 한글, 외부참조(XREF), 배치(Layout)를 실무에서 편하게 확인하는
데 초점을 맞추고 있습니다.

> 현재 버전은 초기 공개 버전입니다. 도면 편집이나 DWG 저장 기능은
> 제공하지 않으며 Linux x64, macOS arm64, macOS Intel x64, Windows x64를
> 지원합니다.

## 주요 특징

### 도면을 외부로 보내지 않습니다

- DWG 변환, 글꼴 처리, 외부참조 탐색과 화면 표시는 모두 로컬에서
  수행합니다.
- 원본을 수정하지 않는 읽기 전용 방식입니다.
- 기본값은 변환 캐시를 도면을 연 세션에서만 사용하고 닫을 때
  삭제합니다. **Scene Cache Mode**를 `persistent`로 선택하면 안전한 로컬
  캐시를 재사용해 다음 열기를 단축할 수 있습니다.

### 국내 CAD 한글 도면을 고려했습니다

- `TEXT`, `MTEXT`, `ATTRIB`, `ATTDEF`와 SHX/BigFont 문자를 표시합니다.
- EUC-KR, CP949/UHC, Johab/CP1361 계열의 오래된 한글 BigFont를
  자동으로 판별합니다.
- 필요한 글꼴을 도면 폴더와 사용자가 지정한 폴더에서 찾고, 누락되거나
  이름이 다른 글꼴은 직접 연결할 수 있습니다.
- 글꼴을 찾지 못한 경우에는 가능한 범위에서 시스템 한글 글꼴로
  대체합니다.

### 큰 도면도 필요한 부분부터 보여줍니다

- 도면 전체를 한꺼번에 화면 메모리에 올리지 않고 현재 화면에 필요한
  형상과 이미지를 불러옵니다.
- 확대가 멈추면 곡선과 패턴을 현재 배율에 맞게 더 정밀하게 표시합니다.
- 고해상도 화면에서는 기본 `hybrid` 모드가 마지막 완성 프레임을 즉시
  이동시키면서 약 80ms마다 저해상도 실제 화면으로 갱신합니다. 따라서
  새로 드러난 영역을 채우면서 픽셀과 드로 호출 부담을 함께 줄입니다.
- 편집기를 닫거나 변환을 취소하면 진행 중인 작업과 임시 자원을
  정리합니다.

### 마우스와 트랙패드 모두 자연스럽게 사용할 수 있습니다

- 기본 **마우스 확대** 모드에서는 톱니식 휠, 프리스핀 휠과 Magic Mouse를
  포함한 모든 일반 스크롤로 커서 위치를 중심으로 확대·축소합니다.
- 트랙패드에서는 도구 모음의 **트랙패드 이동**을 켜면 스크롤 속도와 관계없이
  두 손가락 스크롤로 화면을 이동합니다. 핀치는 두 모드 모두 확대·축소입니다.
- 입력 장치는 자동 판별하지 않으므로 느려진 트랙패드 스크롤이 마우스 휠로
  바뀌는 일이 없습니다.
- 클릭 드래그로도 항상 화면을 이동할 수 있습니다.
- 사각 영역 확대, 전체 보기, 이전/다음 화면과 이름을 붙인 뷰 북마크를
  지원합니다.
- 오른쪽 위와 왼쪽 도구 모음은 각각 아이콘 전용으로 유지하거나,
  마우스를 올리고 키보드로 초점을 맞출 때 모든 이름을 한 번에
  펼치도록 설정할 수 있습니다.
- 뷰어 컨트롤은 VS Code 환경 언어에 따라 영어 또는 한국어를 사용합니다.

### 레이어와 외부참조를 함께 관리합니다

- 레이어 이름 검색, 표시/숨김, 단독 표시, 반전과 이전 상태 복원을
  지원합니다.
- 현재 도면과 각 XREF의 레이어를 도면 내용에 맞춰 자동으로
  그룹화합니다.
- Windows, macOS와 Linux 사이에서 달라지는 경로 형식을 고려해 XREF와
  JPG/PNG 이미지를 찾습니다.
- 원본 도면에 언로드 또는 미해결 상태로 저장된 XREF도 상태 패널에서
  확인하고, 원본을 변경하지 않은 채 이번 세션에서만 명시적으로 로드할 수
  있습니다.
- 자동으로 찾지 못하거나 후보가 여러 개인 참조는 사용자가 직접
  선택하고 연결 범위를 저장할 수 있습니다.

### 도면을 확인하는 데 필요한 도구를 한곳에 모았습니다

- 객체를 선택해 종류, 레이어, 색상과 주요 CAD 속성을 확인합니다.
- 거리, 누적 거리, 면적·둘레, 세 점 각도, 반지름·지름을 측정합니다.
- 단위 없는 도면은 알려진 두 점으로 실제 단위를 보정할 수 있습니다.
- Explorer의 **DWG 문자 검색**에서 워크스페이스 도면의 문자를 한 번에
  찾고, 결과를 선택해 해당 위치로 이동할 수 있습니다.
- 모델 공간과 배치 탭을 오가며 각 배치의 용지 크기와 뷰포트를
  확인합니다.

### 화면과 배치를 바로 공유할 수 있습니다

- 현재 화면, 현재 탭 또는 모든 배치를 PNG/PDF로 저장합니다.
- 배치에 저장된 용지 크기와 회전을 우선 사용합니다.
- 도면이 참조하는 CTB를 연결하면 해당 배치의 출력 색상과 선굵기를
  선택적으로 적용합니다.
- 모든 배치 PNG는 원래 유니코드 배치명 매핑이 포함된 ZIP으로
  저장합니다.

## 시작하기

### 요구 사항

- VS Code 1.125 이상
- Linux x64, macOS arm64, macOS Intel x64 또는 Windows x64

### 설치

VS Code Marketplace에서 **2D CAD Viewer for VS Code**를 설치하면 현재
운영체제와 확장 버전에 정확히 맞는 네이티브 변환기를 같은 GitHub
Release에서 백그라운드로 준비합니다. 다운로드 크기와 SHA-256, 실행 전
자체 진단을 모두 통과한 변환기만 사용합니다. 별도 경로 설정 없이
Explorer에서 `.dwg` 파일을 열면 됩니다.

수동 또는 오프라인 설치에서는
[GitHub Releases](https://github.com/menaje/2d-cad-viewer/releases)의
`dwg-viewer-vscode-<version>.vsix`와 운영체제에 맞는
`dwg-viewer-native-converter-<version>-<platform>`을 내려받습니다. 변환기
선택 명령은 자동 설치를 사용할 수 없는 통제된 오프라인 환경을 위한
대체 경로로만 사용됩니다.

체크섬 확인, macOS 보안 승인과 플랫폼별 자세한 절차는
[배포 및 설치 안내](docs/distribution.md)를 참고하세요.

## 기본 사용법

- **스크롤 입력 모드:** 기본 `mouse-zoom`은 모든 일반 스크롤로 확대·축소.
  도구 모음에서 **트랙패드 이동**을 켜거나 VS Code의 **Scroll Input Mode**를
  `trackpad-pan`으로 설정하면 모든 일반 스크롤로 화면 이동. 자동 판별 없음
- **화면 이동:** 클릭 드래그 또는 `trackpad-pan`의 두 손가락 스크롤
- **확대·축소:** `mouse-zoom`의 휠·Magic Mouse 스크롤 또는 트랙패드 핀치
- **확대 감도:** VS Code의 2D CAD Viewer 설정에서 **Mouse Wheel Zoom
  Sensitivity**와 **Trackpad Pinch Zoom Sensitivity**를 각각 조절
- **도구 이름 확인:** 도구 모음에 마우스를 올리거나 키보드로 초점을
  옮기면 전체 메뉴명이 함께 펼쳐짐
- **간략 메뉴 설정:** VS Code의 2D CAD Viewer 설정에서 **Top Toolbar
  Labels**와 **Left Toolbar Labels**를 각각 `icons` 또는 `hover`로 선택
- **렌더 해상도:** **Render Resolution**을 `auto`(권장), `quality`,
  `performance` 중에서 선택
- **다음 열기 가속:** **Scene Cache Mode**를 기본 `session`으로 두면 도면을
  닫을 때 캐시를 삭제하고, `persistent`로 선택하면 디스크를 더 사용하는
  대신 같은 도면의 다음 열기를 단축. 영구 캐시는 기본 5GiB 안에서 오래된
  도면부터 정리되며 **Scene Cache Maximum Size GiB**에서 상한 조절
- **이동·확대 표시 방식:** **Interaction Rendering**을 `hybrid`(권장),
  `continuous`(새 영역을 매 프레임 표시), `maximumPerformance`(멈출 때까지
  완성 프레임만 이동) 중에서 선택
- **레이어:** 왼쪽 레이어 패널에서 검색하고 표시 상태 변경
- **객체 확인·측정:** 화면 가장자리의 도구 아이콘 선택 후 도면 클릭
- **배치 전환:** 화면 아래쪽 배치 탭 사용
- **문자 검색:** Explorer의 **DWG 문자 검색** 사용
- **내보내기:** **PNG/PDF** 도구에서 범위와 출력 옵션 선택

## 현재 표시 범위

현재 뷰어는 일반적인 2D CAD 도면에 필요한 다음 내용을 표시합니다.

- 선, 폴리라인, 원호, 원, 타원과 스플라인
- 블록, 반복 블록, 치수 그림 블록과 중첩 XREF
- HATCH 솔리드·그라데이션·패턴
- POINT, SOLID, 3DFACE와 WIPEOUT
- TEXT, MTEXT, 속성 문자와 인라인 문자 서식
- 모델 공간, 다중 배치, 뷰포트별 레이어 동결·색상·투명도·선종류·선굵기
- JPG/PNG IMAGE 참조와 XCLIP
- 선종류, 색상, 투명도, 선굵기와 선택적 CTB 출력 스타일

## 알아둘 점

- 이 프로젝트는 뷰어입니다. 도면 편집, DWG 덮어쓰기와 Save As는
  제공하지 않습니다.
- MPL-2.0 확장과 GPL-3.0-or-later LibreDWG 변환기는 별도 릴리스
  파일입니다. 확장은 자기 버전에 고정된 변환기와 대응 소스의 체크섬을
  확인한 뒤 로컬 전역 저장소에서 별도 프로세스로 실행합니다.
- OLE 객체는 삽입 영역의 외곽선만 표시하며, 포함된 Excel이나 그림
  본문은 아직 표시하지 않습니다.
- 외부 이미지는 현재 JPG/JPEG와 PNG를 지원합니다.
- 누락된 XREF, 이미지, SHX 또는 BigFont는 원본 파일을 자동으로 만들 수
  없으므로 사용자가 올바른 로컬 파일을 연결해야 합니다.

## 개발자와 통합 사용자

사용자용 설명과 구현 계약을 분리해 두었습니다.

- [아키텍처](docs/architecture.md)
- [엔진 선택 근거](docs/engine-decision.md)
- [배포와 재현 가능한 패키징](docs/distribution.md)
- [라이선스와 배포 경계](docs/licensing.md)
- [LibreDWG 네이티브 변환기](adapters/libredwg/README.md)
- [Scene Cache 명세](specs/scene-cache.md)
- [Viewer Core 경계 ADR](docs/adr/ADR-0001-viewer-core-boundary.md)
- [`@menaje/viewer-core`](packages/viewer-core/README.md)
- [`@menaje/viewer-render-protocol`](packages/render-protocol/README.md)
- [`@menaje/viewer-ui`](packages/viewer-ui/README.md)
- [`@menaje/dwg-scene-source`](packages/dwg-scene-source/README.md)
- [`@menaje/viewer-webgl`](packages/webview/README.md)

저장소 전체 검증은 다음 명령으로 실행합니다.

```bash
pnpm install --frozen-lockfile
pnpm check
```

VSIX 빌드와 배포 재현 방법은
[배포 및 설치 안내](docs/distribution.md)에 정리되어 있습니다.

## 라이선스

- VS Code 확장과 Viewer 소스: MPL-2.0
- 별도 LibreDWG 네이티브 변환기와 대응 소스 패키지: GPL-3.0-or-later

공식 MPL 2.0 원문은 [LICENSE](LICENSE), 프로젝트 저작권 고지는
[NOTICE](NOTICE)에 분리되어 있습니다. 적용 범위와 배포 시 확인 사항은
[라이선스 안내](docs/licensing.md)를, 번들된 구성요소의 원 저작권·허가문은
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참고하세요. 각 플랫폼
변환기의 정확한 대응 소스와 원문 라이선스는 같은 버전의 GitHub
Release에 함께 제공됩니다.

## 상표 안내

Autodesk, AutoCAD 및 DWG는 Autodesk, Inc.의 등록 상표 또는 상표입니다.
이 프로젝트는 Autodesk와 독립적으로 개발되며 Autodesk의 제휴, 승인, 보증
또는 후원을 받지 않습니다.
