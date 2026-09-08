---
{"schemaVersion":"1.1.0","documentId":"CONI-VIEWER-ADR-0001","title":"Independent Viewer Product and Shared Viewer Core Boundary","type":"adr","version":"1.0.0","status":"accepted","normativity":"normative","authority":["viewer-core-package-boundary","viewer-render-protocol-versioning"],"visibility":"public","supersedes":[],"lastReviewed":"2026-08-30","effectiveAt":"2026-08-15","extensions":{"repository":"viewer","documentRole":"decision-authority"}}
---

# ADR-0001: 독립 Viewer 제품과 공용 Viewer Core 경계

## Context

현재 제품은 raw DWG를 여는 VS Code Custom Editor이며, 검증된 renderer,
camera, interaction, picking과 Scene Cache streaming 구현은
`packages/webview`에 함께 있다. 이 구현은 독립 2D CAD Viewer에서 계속
동작해야 하며, 외부 host도 renderer 코드를 복사하거나 설치된
2D CAD Viewer extension을 제어하지 않고 공개 Viewer Core를 사용할 수 있어야
한다. raw BIM을 read/index/render하는 독립 `bim-explorer`도 공개
consumer로 추가됐으며 source-neutral lifecycle, identity와 selection
계약을 공유해야 한다.

현재 `dwg-*` Host–Webview message와 `acquireVsCodeApi()` 호출은 제품 shell의
private transport다. 이를 public Viewer–Service protocol로 사용하면 VS Code,
Scene Cache와 현재 message lifecycle이 외부 source 구현에 노출된다.

반대로 계약 없이 renderer 파일부터 이동하면 raw DWG 회귀를 만들고,
Render Snapshot/Delta와 Service integration을 구현할 때 다시 경계를
바꾸게 된다.

## Decision

독립 2D CAD Viewer와 BIM Explorer는 각자의 저장소, 설치물과
release를 소유한다. 외부 host는 공개 package 계약으로만 연결한다. `2d-cad-viewer`는 다음 versioned package 경계를
소유한다.

| Package | 책임 | 포함하지 않는 것 |
| --- | --- | --- |
| `@menaje/viewer-render-protocol` | source/session/snapshot/range의 Viewer-facing 계약과 fail-closed validation | host workspace, Agent method, Host private message |
| `@menaje/viewer-core` | source/host lifecycle, renderer, camera, interaction, picking과 generic layer 합성 | DOM bootstrap, VS Code API, DWG parser, permission 판정 |
| `@menaje/dwg-scene-source` | Scene Cache reader, range/detail streaming과 `DwgSceneCacheSource` | Viewer UI, host revision authority |
| `@menaje/viewer-webgl` | Host-neutral WebGL presentation mount와 DWG renderer/delta adapter | VS Code API, host authority, 제품 전용 DOM bootstrap |
| `@menaje/viewer-ui` | 일반 toolbar, inspector와 DOM composition | host semantic panel |
| `@dwg-viewer/vscode-bridge` | VS Code resource/range/file association adapter | public Service protocol |
| `@dwg-viewer/browser-bridge` | Blob/HTTP/mock host adapter | VS Code API |

첫 구현 단위는 `render-protocol`과 `viewer-core`의 최소 계약이다. 그 위에
canonical Scene Cache reader와 `DwgSceneCacheSource`를 두고 기존 Webview
경로는 compatibility re-export로 유지한다. renderer/camera/interaction
lifecycle은 Browser/VS Code conformance를 추가한 뒤 Core로 옮긴다.

BIM Explorer의 source/identity/3D consumer conformance 결과 DWG 형식에
종속되지 않은 공용 package는 `@menaje/viewer-render-protocol`,
`@menaje/viewer-core`, `@menaje/viewer-ui` namespace로 확정했다.
`@menaje/dwg-scene-source`와 Viewer WebGL presentation은 공개 consumer가
독립 설치할 수 있도록 repository owner scope를 사용하고, 제품 bridge는
DWG 제품 전용 이름을 유지한다. public protocol/API ID도
`menaje-viewer-*`로 분리해 Host의
private `dwg-*` message와 혼동하지 않는다.

generic 3D renderer와 BIM exploration UI는 `bim-explorer`가 소유한다.
외부 host의 revision-bound base/live/diff overlay와 Context Reference
integration은 공개 계약을 사용하는 host 소유 adapter의 책임이다. 현재 2D renderer를
범용 3D engine으로 확장하거나 구현을 저장소 사이에 복사하지 않는다.

## Public contract 원칙

`RenderSource`는 지원 render protocol version을 선언하고, 협상된 exact
version으로 session을 연다. 열린 session은 다음을 제공한다.

- session/source/current revision/last-successful revision identity
- bounded resource budget과 feature vocabulary
- revision-bound Render Snapshot
- capability가 선언된 경우에만 range read, revision event, delta와 pick hook
- 취소와 idempotent disposal

`ViewerHost`는 typed Viewer event와 host-owned resource 요청을 처리하는
adapter다. Host는 Workspace authority, Canonical ID authority 또는 trusted
human capability를 발급하지 않는다.

다음은 public package 계약이 아니다.

- `dwg-cache-*`, font/XREF/image와 export를 포함한 기존 Host–Webview message
- `acquireVsCodeApi()`와 Custom Editor lifecycle
- LibreDWG process, native pointer와 실제 source/export path
- IFC parser object, Express ID pointer와 BIM engine 내부 graph
- host의 Agent–Service method, credential와 acceptance/publish 권한

## Version과 compatibility

Viewer Core package, render protocol과 2D CAD Viewer 제품은 각각 semantic
version을 가진다. BIM Explorer product/source package, host protocol과
Viewer package version도 서로 독립적이다.

- `0.x`에서 breaking contract change는 minor version을 올린다.
- compatible validation/diagnostic 수정은 patch version을 올린다.
- source와 Core는 exact render protocol version을 handshake에서 선택한다.
- product version이나 Host private message version으로 호환성을 추측하지
  않는다.
- producer manifest는
  [`compatibility/viewer-core.json`](../../compatibility/viewer-core.json)에
  기록한다.
- consumer는 package/version range와 실제 conformance 결과를 별도 manifest에
  pin한다.

public preview package 0.1.0, 0.1.1과 0.1.2는 기록으로 보존하고, 현재 preview
0.1.3은 `viewer-core-v0.1.3` GitHub Release tarball과 GitHub Packages에
함께 배포한다. producer manifest는 artifact SHA-256과 exact render
protocol compatibility window를 기록하고, consumer는 자신의 lockfile과
compatibility manifest에서 exact artifact를 pin한다. 0.x 범위를 벗어나는
호환 주장은 cross-repository fixture 없이 하지 않는다.

상호작용 중 detail streaming pause/resume과 async staged Render Delta
lifecycle은 Viewer Core 0.1.3 package 경계로 qualification한다. 세 package는
두 번 pack한 digest와 artifact-only staged 3D consumer fixture를 통과하며,
기존 동기 adapter와 wire protocol identity를 유지한다. 새 tag와 package
publication은 매 version마다 별도 promotion 승인이 있을 때만 수행한다.

## Extraction 순서

1. 계약 package, producer compatibility manifest와 mock conformance
2. `DwgSceneCacheSource`와 Browser mock source
3. VS Code/DOM bootstrap에서 Viewer lifecycle 분리
4. 같은 Core를 사용하는 Browser와 VS Code qualification
5. Service RenderSource, external identity/context event
6. ordered Render Delta와 revision diff
7. BIM Explorer의 source-neutral 3D consumer conformance
8. host-owned base/identity/live-diff integration conformance

각 단계는 raw DWG open, selection, measurement, Korean text, first-frame와
memory qualification을 유지해야 한다. 파일 이동 자체를 완료 조건으로
삼지 않는다.

## Consequences

- 기존 Webview와 새 package가 잠시 공존한다.
- 초기에는 adapter code가 얇게 중복 연결될 수 있지만 renderer 구현을
  복사하지 않는다.
- public contract는 현재 VS Code message보다 작고 source-neutral하다.
- BIM Explorer는 standalone 2D CAD Viewer 설치 없이 `BimModelSource`와
  generic 3D surface를 제공할 수 있다.
- 외부 host는 standalone 2D CAD Viewer 설치 없이 호환 package를 bundle할
  수 있으며 BIM Explorer extension 설치에도 의존하지 않는다.
- 2D와 3D surface는 같은 lifecycle/identity/selection 계약을 사용하지만
  서로 다른 renderer backend와 제품 package를 가질 수 있다.

## Implementation status

2026-08-03 기준으로 1–2단계의 contract, compatibility manifest,
`DwgSceneCacheSource`, Browser mock과 공용 conformance가 구현되었다.
standalone Browser와 VS Code Webview도 같은 `openViewerRuntime()`에서
source/snapshot을 열고 기존 renderer presentation을 mount한다. canonical
Scene Cache reader는 `dwg-scene-source`에만 있으며 Webview의 과거 경로는
re-export다. source-neutral 2D camera도 Viewer Core로 이동했고 과거
Webview 경로는 같은 구현을 re-export한다.
source-neutral GPU batch LRU도 같은 방식으로 Core가 canonical 구현을
소유한다. Canvas viewport interaction lifecycle 역시 Core가 소유하고,
`ViewerRendererController`가 renderer capability와 root/XREF detail target
수명주기를 검사·조정한다. 상세 청크의 concurrency, byte-budget cache,
stale work, review publication과 redraw coalescing은
`DetailStreamingController`로 이동했다. 현재 Webview adapter는 Scene
Cache batch 가시성 계산과 reader/WebGL mapping만 주입한다.
`ViewerSelectionController`는 DWG pick projection을 active
session/revision/snapshot에 묶어 monotonic `selection.changed` Host event로
전달한다.
`pick.resolve`, Render/Pick/external identity, Context Reference와 source
reveal descriptor도 같은 snapshot layer와 revision에 묶여 검증된다.
`ViewerIdentityController`는 Service source의 identity/context/reveal hook을
호출하고 opaque reference만 `context.request`와 `source.reveal` Host event로
전달한다. `MockServiceRenderSource`와 재사용 가능한 service conformance는
base/live layer 합성, stale pick 거부와 disposal을 실행한다. 실제
service-backed source, Canonical ID authority와 Context 저장소는 계속
consumer-specific integration layer의 책임이다.
`Render Delta`는 base snapshot, exact from/to revision, monotonic sequence,
affected bounds와 bounded opaque payload에 묶인다.
`ViewerRenderDeltaController`는 전체 entity graph 대신 변경된 Render ID의
tombstone/upsert, dependency/identity map과 preview만 보관하고 rollback 시
immutable base를 다시 읽지 않는다. renderer adapter hook은 원자적인 apply,
preview rollback/promotion만 요구하며 현재 Webview의 private DWG GPU
vertex format은 public protocol로 승격하지 않는다. Webview의
`DwgRenderDeltaAdapter`는 검증된 decoded v6
line/triangle-fill/POINT/Canvas-text/direct-instance-transform/
direct-instance-style packet의 resource를 먼저 stage하고 renderer state를
한 번에 교체한다. WebGL payload는 공용 64 MiB, native text, transform,
style은 각각 8 MiB 한도를 사용한다. private v1 line-only, v2 line/fill,
v3 line/fill/POINT, v4 Canvas-text 및 v5 instance-transform packet은
producer 전환 기간에 계속 읽는다.
base tombstone/upsert는 line
vertex handle, HATCH/POINT/SOLID/3DFACE/WIPEOUT의 압축 identity-range
sidecar와 Canvas text의 source-scoped handle filter를 통해 cached draw
range로 적용한다. 따라서 Scene Cache buffer를 수정하지 않으며 preview
rollback과 promotion은 같은 native identity/pick map을 사용한다.
비동기 GPU/worker consumer는 기존 wire shape를 유지하고 additive staged
adapter lifecycle을 사용한다. `prepareDelta()`는 current scene을 건드리지 않고
CPU/GPU/range/worker 자원을 준비한 뒤 `commit()`, `rollback()`, `dispose()`
transaction을 반환한다. Core는 stale·budget·ordering을 prepare 전에 거부하고,
prepare 뒤에는 cancellation과 controller lifecycle을 다시 확인한다. 동기
`commit()` 성공 시 geometry와 pick/identity revision이 함께 전환되며 실패나
취소에서는 rollback/dispose가 완료될 때까지 transaction을 해제하지 않는다.
기존 동기 `applyDelta()` consumer는 그대로 호환된다.
direct INSERT transform은 block geometry를 복제하지 않고 root/XREF의
addressed packed occurrence display/measurement matrix만 희소 교체한다.
direct INSERT style은 같은 occurrence의 resolved color/layer/opacity/
lineweight/linetype/visibility만 희소 교체한다. WebGL, Canvas text와 raster
image가 같은 transform/style state를 사용한다. transform은 파생 XCLIP을
다시 계산해야 하는 occurrence에서 fail-closed하고, style-only 변경은
XCLIP occurrence에도 적용할 수 있다. root/XREF의 compact instance
topology를 bounded DFS로 다시 순회해 영향받은 nested child의 matrix와
상속 style만 파생하며 block geometry는 복제하지 않는다. descendant의
direct sparse record는 ancestor에서 파생한 상태보다 우선한다. 이동할
descendant가 XCLIP을 가지면 transform 전체를 거부하고, transform/style
파생 record는 각각 8 MiB로 제한한다. 같은 native handle의
MINSERT/repeated occurrence는 모두 한 atomic packet에 포함되어야 한다.
DWG dependency ID는 Viewer Core에서 계속 opaque로 유지하되 Webview
adapter에서만 scene과 native handle을 포함한 canonical block/type ID를
해석한다. block invalidation은 해당 root/XREF block의 immutable WebGL,
Canvas text, raster image base cache만 제외하고, type invalidation은 해당
scene의 base cache를 보수적으로 제외한다. delta overlay는 계속 표시한다.
cache resource를 파괴하거나 다시 쓰지 않으므로 preview rollback은 같은
atomic state swap으로 즉시 원복되며, DWG 형식이 아닌 알 수 없는 dependency
ID는 추측하지 않고 관찰 상태로만 보존한다.
adapter는 renderer가 반환한 staged resource를 별도 소유 집합으로 추적한다.
commit/promotion/rollback 중 superseded resource 회수가 실패하면 Core 상태를
게시하기 전에 직전 committed 또는 preview renderer state를 다시 활성화한다.
따라서 같은 전이를 재시도할 수 있고, source 전환과 idempotent disposal은
active/committed/preview에 흩어진 소유 resource를 중복 없이 전부 회수한다.
같은 atomic state에는 현재 revision과 native identity pick map도 포함된다.
root/XREF overview, detail, exact-curve와 filled-object 인덱스는 후보를
확정하기 전에 renderer의 현재 map을 조회하므로 tombstone, 대체된 base와
dependency-invalidated base를 다음 후보로 넘긴다. sparse transform이
적용된 occurrence의 과거 CPU 좌표와 hidden style occurrence는 fail-closed로
제외한다. Canvas text delta hit는 base hit와 구분되어 upsert identity로
해결되며, preview rollback은 base pick revision과 후보 허용 상태를 같은
swap으로 복원한다. 최종 후보만 current revision/Render ID/external
identity로 투영하고 selection controller가 그 revision으로 이동한 뒤 Host
event를 발행하므로 후보 순회에는 전체 identity object 할당이 추가되지 않는다.
`MockRenderDeltaSource`와 공용 conformance는 stale replay 뒤에도
source/overlay/pick revision이 함께 전진하는지 검증한다.
`ViewerRenderDiffController`는 제품이 제공하는 compact base Render ID
membership와 총 개수만 사용해 changed ID를 added/removed/modified로
분류하고 unchanged는 총계로 계산한다. 따라서 immutable base entity를
열거하지 않으며 added 뒤 removed된 ID는 net diff에서 제외된다. preview와
rollback은 같은 revision-bound summary를 사용한다.
`ViewerDiffOverlayController`는 이 summary에 added/removed/modified/
unchanged별 visibility, canonical hex color와 opacity 정책을 결합한다.
unchanged는 계속 ID를 열거하지 않고 global style만 전달한다. 상태 visibility는
source/layer/clip visibility와 반드시 교집합으로 적용하므로 diff 정책이 숨겨진
source geometry를 다시 노출하지 않는다. renderer adapter 적용은 동기·원자적
경계이며 실패하면 직전 정상 presentation을 재적용하고 불완전한 rollback은
관찰 후 재동기화할 수 있다. DWG 제품 adapter는 changed Render ID를 활성
line/fill/point/text resource와 native handle에 연결한다. WebGL shader는 기존
layer/viewport/clip 판정 뒤에만 상태 tint와 opacity를 적용하고, removed는
억제된 base range 중 해당 handle만 다시 그린다. Canvas text도 같은 정책을
적용하되 source-hidden text를 다시 노출하지 않는다. direct transform/style
identity는 root/XREF shared block의 packed INSERT occurrence index만 상태별로
분할한다. 명시적인 child resource와 removed base range가 containing INSERT
상태보다 우선하며, Canvas block text도 occurrence loop에서 같은 precedence를
사용하므로 block geometry를 복제하지 않는다.
`ViewerSplitViewCameraController`는 서로 다른 before/after surface adapter에
불변의 논리 2D 카메라만 전달한다. 각 surface의 revision, scene, GPU/detail
state와 canvas 비율은 공유하지 않으며 renderer가 자신의 `worldWidth`를
계산한다. 한쪽 interaction에서 온 카메라는 반대쪽에만 적용하고 programmatic
전환은 양쪽에 적용한다. 실패한 전환은 마지막 정상 카메라로 rollback하며,
불완전한 rollback은 명시적으로 관찰하고 재동기화할 수 있다. surface disposal과
renderer lifecycle은 계속 제품 책임이다.
`ViewerSplitViewDiffController`는 base/target revision과 동일한 frozen
changed-ID mapping을 양쪽에 전달하며 선택한 corresponding Render ID도 동일한
highlight로 적용한다. 한쪽 적용 실패는 양쪽의 마지막 정상 mapping으로
rollback한다. `ViewerSplitViewUiController`는 주입된 두 surface의 실제
접근 가능한 DOM split, bounded divider와 원래 DOM 위치 복원을 소유한다.
`ViewerDiffSemanticController`는 identity/dependency change와 invalidation만
revision-bound `diff.open` Host event로 투영한다.
`@menaje/viewer-ui`의 review controller는 toolbar의 active
state와 접근성 속성, bounded text-only result row/action composition,
DOM listener disposal을 소유한다. 네 diff 상태와 base/target revision도
같은 result model로 투영한다. DWG Webview는 candidate 판독과 CAD 속성,
측정 결과를 이 source-neutral view model로 투영한다.

아직 `packages/webview`에 있는 실제 WebGL CAD shader, DWG candidate decoder와
selection/measurement overlay, generic render data model의 물리적 package
이동은 남아 있다. 일반 Viewer UI의 layer/layout panel composition도 이후
단계다. #30의 실제 cross-repository service-backed source qualification은
남아 있다. #27은 378,400-base public delta fixture와 2026-08-04의
24,680,147-byte 제품 재검증으로 완료했다. 실제 제품 결과는 `status: ok`,
first usable frame 5,220 ms, 증분 물리 메모리 564,907,536 bytes와 완전한
cleanup이며 각각 8초/800 MB hard gate 안이다.
제품 진입점을
먼저 runtime 계약에 연결했으므로 이후 이동은 raw range transport나 VS Code
private message를 Core API로 승격하지 않고 진행한다.

2026-08-04에는 Viewer 저장소 소유 경계를
`pnpm run qualify:viewer-boundary`로 고정했다. 이 Gate는 public package를
두 번 pack하고 gzip platform metadata를 정규화해 runner 간 byte 동일성과
platform-neutral content digest를 확인하며, 실제 archive의 raw digest/size가
producer manifest와 일치해야 한다. 빈 임시 consumer에 tarball만 설치해
source/service conformance와 외부 제품 없는 standalone runtime lifecycle을
실행한다. Browser HTML과 VS Code bundle도 같은
`packages/webview/src/main.mjs`에서 `DwgSceneCacheSource`와
`openViewerRuntime()`을 사용해야 통과한다. 결과는
[`viewer-boundary-0.1.3-2026-08-15.json`](../../compatibility/evidence/viewer-boundary-0.1.3-2026-08-15.json)에
고정한다.

현재 `viewer-core-v0.1.3`은 prerelease로 유지한다. 새 tag publish는
producer manifest의 `tagPublicationApproved`를 별도 변경하지 않으면
workflow가 거부하며 stable 자동 승격은 없다. 이 qualification은
`2d-cad-viewer` 소유 경계만 실행하며 외부 consumer-owned 결과를
대신 주장하지 않는다.

`bim-explorer`의 `BimModelSource`와 3D consumer는 아직 구현되지 않았다.
따라서 current package가 truly source-neutral하거나 3D-compatible하다고
주장하지 않으며 해당 evidence는
[bim-explorer #3](https://github.com/menaje/bim-explorer/issues/3)에서
추적한다. 외부 host의 identity/overlay integration qualification은
해당 host 소유 경계에서 별도로 입증해야 한다.

## Revisit

실제 `DwgSceneCacheSource`, `BimModelSource` 또는 service-backed source
conformance가 현재 session/snapshot 경계로 구현되지 않거나, 독립 제품
qualification이 반복해서 깨질 때 이 결정을 재검토한다. public contract
변경은 기존 version의 의미를 바꾸지 않고 새 version과 migration fixture로
수행한다.
