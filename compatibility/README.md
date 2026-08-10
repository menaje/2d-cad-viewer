# Viewer compatibility

`viewer-core.json`은 이 저장소가 생산하는 Viewer Core, Viewer UI와 render
protocol의 호환 기준을 기록한다.

`viewer-webgl.json`은 다른 제품이 확장 프로그램이나 private
Host–Webview message 없이 사용할 수 있는 WebGL presentation과 DWG Scene
Cache source package의 버전, 공개 mount, exact artifact digest와 publication
승인을 별도로 기록한다. 제품 bootstrap은 이 공개 계약에 포함되지 않는다.
`developmentQualification`은 아직 새 package tag로 배포하지 않은 소스의
추가 public API와 검증을 기록한다. 이 항목은 기존 `distribution`의 immutable
0.1.1 artifact digest를 바꾸거나 새 버전이 배포됐다는 뜻이 아니다.

- `public-preview`는 package/API가 공개 배포됐지만 아직 `0.x` compatibility
  window에 있다는 뜻이다.
- `releaseStage: prerelease`는 현재 GitHub Release가 최종 승격되지 않았다는
  뜻이다. `tagPublicationApproved: false`인 commit에서는 태그 workflow가
  package나 Release를 배포하지 않는다.
- `github-release-and-packages`는 공개 GitHub Release tarball과 GitHub
  Packages npm package를 함께 배포한다는 뜻이다.
- consumer는 release tarball의 exact URL과 SHA-256을 pin하거나 GitHub
  Packages의 exact version을 pin한다.
- consumer는 이 파일을 복사하지 않고 자신의 manifest에서 package version
  range와 실행한 conformance fixture를 기록한다.
- `product-runtime`은 해당 Host의 실제 제품 진입점이 Viewer Core runtime을
  거친다는 뜻이며 cross-repository package 배포 완료를 뜻하지 않는다.
- `core-lifecycle-with-*-adapter`는 lifecycle과 fail-closed contract는
  Core가 소유하지만 source-specific renderer 또는 pick decoder는 제품
  adapter가 제공한다는 뜻이다.
- `canonical-with-*-policy`는 cache/concurrency/disposal 구현은 Core가
  canonical이지만 가시성·선택 정책은 source adapter가 주입한다는 뜻이다.
- `canonical-dom-lifecycle-with-*-adapter`는 toolbar/result DOM 상태와
  disposal은 Viewer UI가 소유하고 product-specific 결과 의미는 adapter가
  투영한다는 뜻이다.
- 제품 version, Spatial Protocol version과 Host–Webview message version으로
  Viewer Core 호환성을 추측하지 않는다.

실제 package version, protocol version, artifact digest 또는 conformance
경로가 바뀌면 manifest와 package test를 같은 변경에서 갱신한다.

`Viewer WebGL packages` workflow는 `packages/webview/package.json`을
유일한 release-version 기준으로 읽고 `viewer-webgl-v<version>` 태그와
Scene Cache package version을 검증한다. 따라서 버전 문자열을 release
화면이나 consumer 문서에 사람이 따로 맞춰 입력하지 않는다.

`pnpm run qualify:viewer-boundary`는 세 public tarball을 두 번 pack해 같은
gzip platform metadata를 정규화한 runner 간 byte 동일성과 platform-neutral
package content SHA-256을 확인하고, 실제 archive의 raw SHA-256/size가
producer pin과 일치하는지 검증한다. 빈 임시 consumer에는
artifact만 설치해
RenderSource/Service fixture와 standalone runtime을 실행한다. Browser와
VS Code가 같은 Webview entrypoint를 bundle하는지도 확인한다. 이 저장소가
소유하지 않는 BIM/Spatial consumer qualification은 실행하거나 수정하지
않으며 각 consumer manifest가 책임진다. 현재 고정 evidence는
[`evidence/viewer-boundary-0.1.2-2026-08-04.json`](evidence/viewer-boundary-0.1.2-2026-08-04.json)에
있다.

`native-document-adapter.json`은 raw DWG query/change/write backend의
operation별 admission을 별도로 기록한다. 현재 Native는 bounded packed
query만 `query-preview`이고 writer는 실제 no-op round-trip 실패 때문에
output 예약 전에 `blocked`된다. WASM MEMFS 후보도 memory/Browser Gate
실패로 제품 비허용이다. 계약 fixture의 writer 성공은 실제 LibreDWG writer
승격으로 해석하지 않는다. 실행 증거는
[`evidence/native-document-adapter-2026-08-04.json`](evidence/native-document-adapter-2026-08-04.json)에
있다.

공개 한국 DWG 자격검사는 고정된 공공누리 제1유형 데이터 포털 catalog와
archive byte 수·SHA-256을 확인하고, 현재 catalog의 이용조건이 여전히
제1유형인지 실행 때마다 다시 검사한다. 63개 실제 DWG 중 버전·크기 균형
표본 30개가 30 pass / 0 target miss / 0 failure를 기록했다. 이 결과는
AC1018/AC1021/AC1032, 건축, CP949/Unicode와 관측된 SHX/BigFont/TTF
참조에 한정된다. AC1015/AC1024/AC1027, 토목/설비, strict
EUC-KR/Johab, Extended BigFont와 외부 이미지 기준은 지원 또는 검증했다고
주장하지 않는다. 경로와 원문이 없는 고정 결과는
[`evidence/public-korean-corpus-2026-08-04.json`](evidence/public-korean-corpus-2026-08-04.json)에
있다.

Windows x64 자격검사는 Windows Server 2025 GitHub runner에서 정적
LibreDWG 패키지를 두 번 만들어 byte 동일성, doctor, 내부 checksum과
source-complete 구성을 확인했다. 실제 Windows 파일 시스템의 drive, UNC,
상대·한글 NFC/NFD·대소문자 경로와 취소 정리도 통과했다. 최신 안정판
VS Code 1.131.0에 패키징한 VSIX를 설치해 100/125/150/200% 배율과
일반/좁은 폭에서 선택·좌표·거리·전체 보기·지우기·Model/Paper 초기화를
검증하고 8개 화면의 byte 수와 SHA-256을 고정했다. 이 결과는 물리
Windows 11 실행, 비공개 A2-013 또는 복합 XREF/XCLIP 도면 실기를
주장하지 않는다. 해당 항목의 제품 중립 계약 검증과 실제 Windows UI
검증은 구분한다. 경로 없는 고정 결과는
[`evidence/windows-qualification-2026-08-04.json`](evidence/windows-qualification-2026-08-04.json)에
있으며, 이 자격검사에서는 배포하지 않았다.

Viewer WebGL full-scene comparison의 공개 Browser fixture, 패키징된 macOS
VS Code actual-pixel 결과, 공공누리 DWG open과 경로 없는 private large-drawing
Gate는
[`evidence/viewer-webgl-comparison-2026-08-10.json`](evidence/viewer-webgl-comparison-2026-08-10.json)에
있다. 선택된 물리 전략은 하나의 renderer와 두 bounded raster surface이며,
두 번째 full WebGL context/cache 전략은 현재 600 MB target 여유가 부족하므로
별도 Gate 전에는 지원으로 표시하지 않는다.
