# `@menaje/viewer-core`

Viewer renderer와 source/host lifecycle을 VS Code, DWG parser와 Spatial
Workspace에서 분리하기 위한 최소 public contract입니다.

## 설치

공개 Release tarball의 exact URL과 SHA-256은
`compatibility/viewer-core.json`에 고정되어 있습니다. clean consumer는
protocol과 Core를 함께 설치합니다.

```sh
npm install \
  https://github.com/menaje/dwg-viewer/releases/download/viewer-core-v0.1.2/menaje-viewer-render-protocol-0.1.2.tgz \
  https://github.com/menaje/dwg-viewer/releases/download/viewer-core-v0.1.2/menaje-viewer-core-0.1.2.tgz
```

GitHub Packages를 사용할 때는 `@menaje` scope를
`https://npm.pkg.github.com`에 연결하고 두 package의 exact `0.1.2`를
설치합니다.

현재 소스의 Viewer Core `0.1.3`은 additive async staged-delta API를 검증하는
미배포 development artifact입니다. 공개된 `0.1.2` package와 artifact는
교체하지 않으며, 기존 동기 adapter는 `0.1.3`에서도 그대로 동작합니다.

## RenderSource

Source는 다음을 제공합니다.

- `supportedProtocolVersions`
- `open({ protocolVersion, signal })`
- `dispose()`

열린 session은 `descriptor`, `getSnapshot()`과 `dispose()`를 제공해야
합니다. capability를 선언하면 해당 method도 반드시 구현해야 합니다.
예를 들어 `range-read`는 `readRange()`, `revision-events`는
`subscribeRevisionEvents()`, `diagnostics`는 `subscribeDiagnostics()`를
요구합니다. Service-backed source는
`pick-resolve`, `context-create`, `source-reveal` capability에 맞춰 각각
`resolvePick()`, `createContext()`, `resolveSourceReveal()`을 구현합니다.

`openRenderSource()`는 version을 협상하고 descriptor/snapshot binding을
검증하며, stale 또는 out-of-order 상태를 화면에 전달하기 전에 거부합니다.
pick/context/reveal 응답도 요청 전후에 active snapshot을 검사하므로 작업
도중 snapshot이 바뀌면 늦은 응답을 `STALE_REVISION`으로 거부합니다. 모든
disposal은 idempotent합니다.

available revision event가 새 snapshot ID를 알리면 다음 `getSnapshot()`은
그 revision과 snapshot ID가 정확히 일치할 때만 active state를 전환합니다.
failed event는 마지막 정상 snapshot과 render revision을 유지합니다.
revision/diagnostic subscription은 각각 monotonic sequence를 검사하고 replay와
out-of-order delivery를 listener에 노출하기 전에 거부합니다.

## Render Delta

`render-delta` capability를 선언한 session은
`subscribeRenderDeltas(listener)`를 구현합니다.
`ViewerRenderSourceSession.subscribeRenderDeltas()`는 base snapshot,
from/to revision과 직전 sequence를 검증하고, listener가 전체 delta를
성공적으로 원자 적용한 뒤에만 session의 `revisionId`를 전진시킵니다. 실패한
delta 일부는 노출되지 않으며 subscription의 `lastError`, `whenIdle()`과
`onError`로 관찰할 수 있습니다.

`ViewerRenderDeltaController`는 immutable base를 다시 읽지 않고 변경된
Render ID만 보관합니다.

- entity tombstone filter와 aspect별 upsert overlay
- affected bounds, dependency invalidation과 external identity map 갱신
- 하나의 preview 적용, rollback과 promotion
- delta count/payload bytes/overlay entry/dependency ID 기준 checkpoint 권고 및
  hard limit
- stale/out-of-order 입력 전 상태 보존과 idempotent disposal

기존 2D renderer adapter는 동기·원자적인 `applyDelta()`,
`rollbackPreview()`, `promotePreview()`, `dispose()` 경계를 계속 사용합니다.
비동기 renderer는 additive `prepareDelta(delta, { signal })` 경계를 구현하고
`ViewerRenderDeltaController.applyCommittedAsync()`를 사용합니다.
`prepareDelta()`는 화면 상태를 바꾸지 않은 채 다음 transaction을 반환해야
하며 transaction은 `commit()`, `rollback()`, `dispose()`를 제공합니다.
`commit()`만 동기적이고 원자적입니다. 성공 시 geometry와 pick/identity를 같은
revision으로 한 번에 교체하고 staged resource ownership을 adapter로 이전합니다.
prepare가 transaction을 반환하기 전에 실패하면 adapter가 자체 staged 자원을
정리해야 하며, 반환 뒤의 실패·stale·취소는 Core가 rollback과 dispose를 모두
await합니다. 준비 중 종료에는 `disposeAsync()`를 사용합니다.

DWG vertex layout이나 특정 3D packet 의미는 Core 계약에 포함되지 않습니다.
`MockRenderDeltaSource`, `MockStagedRenderDeltaAdapter`,
`runRenderDeltaConformance()`와 `runStagedRenderDeltaConformance()`가 ordered
apply, stale replay, 느린 prepare 중 상태 보존, geometry/pick 원자 commit,
digest mismatch, commit failure, cancellation과 terminal disposal을 검증합니다.

`ViewerRenderDiffController`는 제품이 제공하는 compact base Render ID
membership index와 총 개수만 사용해 현재 delta의 net 상태를 `added`,
`removed`, `modified`, `unchanged`로 분류합니다. changed Render ID만
열거하고 unchanged는 총계로 계산하므로 immutable base 전체를 JavaScript
entity graph로 펼치지 않습니다. preview 적용과 rollback도 같은 delta
snapshot을 읽어 네 상태와 revision을 함께 전환합니다.

`ViewerDiffOverlayController`는 이 revision-bound summary를 상태별
`visible`, canonical hex `color`, `opacity` 정책과 결합합니다. 기본값은
added `#3fb950`, removed `#f85149`, modified `#d29922`, unchanged native
색상과 35% opacity입니다. unchanged ID는 계속 열거하지 않으며 renderer
adapter는 상태 visibility를 source/layer/clip visibility와 교집합으로만
적용해야 합니다. 따라서 diff UI가 숨긴 source geometry를 다시 노출할 수
없습니다. 정책 적용 실패는 직전 정상 presentation으로 rollback하고,
불완전한 rollback은 관찰·재동기화할 수 있습니다. controller disposal은
diff presentation만 clear하며 renderer adapter 자체의 lifecycle은 소유하지
않습니다.

`ViewerDiffSemanticController`는 같은 summary에서 `identity`와
`dependency` aspect만 bounded projection으로 만들고 revision/snapshot,
monotonic event sequence, 전체 상태 count와 invalidated dependency ID를
`diff.open` ViewerHost event로 전달합니다. 시각 geometry entry나 unchanged
Render ID를 외부 semantic panel에 복제하지 않으며 Host lifecycle도 소유하지
않습니다.

37만 8,400개 base Render ID를 모델링하는 공개 qualification fixture는 base
entity를 만들거나 열거하지 않고 8개 delta의 768개 changed ID만 유지합니다.
동일 fixture가 checkpoint 권고, preview rollback, 실패한 staging 뒤 마지막
정상 revision, overlay/split의 동일 매핑과 bounded retained summary를
검증합니다. 2026-08-04의 24,680,147-byte 실제 도면 제품 재검증도
`status: ok`였고, 증분 물리 메모리 564,907,536 bytes와 종료 cleanup은 gate를
통과했습니다. 첫 usable frame 5,220 ms는 5초 target miss이지만 8초 hard
limit 안입니다. private 도면과 원본 report는 저장소에 커밋하지 않습니다.

`createRenderLayerRangeSource()`는 snapshot의 range-backed layer 하나를
기존 bounded reader가 소비할 수 있는 source로 projection합니다.
`openViewerRuntime()`은 source session과 최초 snapshot을 연 뒤 제품이
제공한 `mount()`를 실행하고, 반환된 presentation·source·Host의 lifecycle을
한 번에 소유합니다. mount 실패나 취소에서도 같은 자원을 정리합니다.

`@menaje/viewer-core/testing`은 브라우저에서도 실행 가능한
`MockRenderSource`, base/live layer와 identity hook을 갖춘
`MockServiceRenderSource`, ordered tombstone/upsert fixture를 갖춘
`MockRenderDeltaSource`를 제공합니다.
`@menaje/viewer-core/conformance`의
`runRenderSourceConformance()`는 공통 lifecycle/range 계약을,
`runServiceRenderSourceConformance()`는 pick/external identity/context/reveal
계약과 stale pick 거부를 검증합니다.
`runServiceEventConformance()`는 ordered revision/diagnostics와 replay 거부를
검증합니다. `runRenderDeltaConformance()`는
두 ordered delta 사이의 stale replay가 source와 overlay revision을
오염시키지 않는지 검증합니다.

## ViewerHost

Host는 최소 `handleEvent()`와 `dispose()`를 제공합니다. 선택적으로
host-owned resource를 위한 `openResource()`를 제공할 수 있습니다.

Viewer event vocabulary는 `revision.changed`, `selection.changed`, `viewport.changed`,
`context.request`, `source.reveal`, `diagnostics.changed`, `diff.open`,
`humanAction.request`입니다. `ViewerIdentityController`는 제품의 bounded pick
projection을 source의 revision-bound external identity로 resolve하고,
opaque Context Reference와 source reveal을 각각 `context.request`,
`source.reveal` event로 전달합니다. 두 event detail은 protocol/session/
revision/snapshot/layer scope, monotonic sequence, reason, identity와 opaque
reference를 포함합니다. `humanAction.request`는 intent일 뿐 capability 또는
approval evidence가 아닙니다.
`ViewerServiceEventController`는 source revision/diagnostics subscription을
Host event로 전달하고 revision-bound viewport와 `humanAction.request` intent를
발행합니다. source에 human-action capability를 요구하거나 권한을 발급하지
않으며 Host와 source lifecycle도 소유하지 않습니다.
`ViewerDiffSemanticController.open()`은 시각 diff와 같은 revision에 묶인
`diff.open` detail을 발행하므로 외부 semantic panel이 source private
message나 전체 entity graph 없이 non-visual change를 표시할 수 있습니다.

현재 package에는 DOM bootstrap, `vscode`, `acquireVsCodeApi()`, Scene Cache
parser와 Spatial permission code가 없습니다. Browser와 VS Code 제품
진입점은 이미 같은 runtime과 `DwgSceneCacheSource`를 거칩니다.
source-neutral
`CameraController2D`와 viewport bounds는 Core의 canonical 구현이며
`@menaje/viewer-core/camera`로도 노출합니다. Renderer가 소유한 GPU
batch를 byte budget으로 관리하는 `GpuBatchCache`도 source-neutral Core
모듈이며 `@menaje/viewer-core/batch-cache`로 노출합니다. Canvas
viewport의 pan/zoom/window-zoom, view commit, redraw와 detail lifecycle은
`ViewportInteraction`이 소유합니다.

`ViewerRendererController`는 redraw/camera와 root·external detail target
계약을 fail-closed로 검사하고 target별 GPU resource disposal을 조정합니다.
`ViewerSplitViewCameraController`는 before/after surface가 각자 renderer,
revision과 canvas 비율을 유지한 채 불변의 논리 카메라(`origin`,
`worldHeight`)만 공유하도록 조정합니다. 한쪽 surface가 이미 적용한 카메라는
`setCameraFrom()`으로 반대쪽에만 전달하며, programmatic 전환은 양쪽에 같은
카메라 객체를 적용합니다. 동기화 실패 시 마지막 정상 카메라를 양쪽에 다시
적용하고, 불완전한 rollback은 `synchronized: false`로 표시해
`synchronize()`로 재시도할 수 있습니다. 이 컨트롤러는 surface 자원을
dispose하지 않으므로 두 renderer lifecycle은 계속 독립적입니다.
`ViewerSplitViewDiffController`는 두 surface에 base/target revision과 정확히
같은 frozen changed-ID mapping을 전달합니다. 선택한 changed Render ID도
동일 객체로 양쪽에 전달해 corresponding entity를 강조하며, 한 surface 적용이
실패하면 둘 다 마지막 정상 mapping/highlight로 rollback합니다. 이 controller
역시 renderer나 surface 자원을 dispose하지 않고 presentation만 clear합니다.
`DetailStreamingController`는 selection policy와 byte loader를 주입받아
동시성, visible/cache budget, stale work, review geometry와 redraw
coalescing을 소유합니다. 현재 Webview의 `DetailStreamer`는 DWG Scene Cache
batch selection과 reader/renderer mapping만 담당하는 얇은 adapter입니다.

`ViewerSelectionController`는 제품 pick을 source-specific projector로
정규화한 뒤 active session/revision/snapshot에 결합하고 monotonic
`selection.changed` event를 ViewerHost에 전달합니다. 현재 DWG adapter는
handle, source, layer와 point만 투영합니다. Service source는
`ViewerIdentityController.resolvePick()` 결과를 같은 selection projection에
사용해 external identity token과 world bounds를 유지할 수 있습니다.
Render Delta를 적용한 adapter는
`ViewerSelectionController.advanceRevision()`으로 기존 선택을 지우고 다음
`selection.changed`를 적용된 render revision에 묶습니다.

`ViewerLayerCompositionController`는 snapshot의 base/live/added/modified/
removed/diagnostic/selection/annotation layer를 `order`와 layer ID로
결정적으로 정렬합니다. 2D, 3D와 semantic representation을 같은 계약에서
유지하며 visibility 또는 snapshot 전환을 adapter에 원자 적용합니다. 적용
실패 시 마지막 정상 presentation을 복원하고, controller disposal은
composition만 clear하며 renderer adapter 자체를 소유하지 않습니다.

실제 WebGL CAD shader와 CPU DWG candidate decoder, DOM inspector는 아직
`packages/webview`에 있습니다. Core는 이 구현을 import하지 않으며 이후
renderer data model과 일반 `viewer-ui` 경계를 별도 단계로 이동합니다.

일반 review toolbar와 result panel의 DOM lifecycle은 별도
`@menaje/viewer-ui` package가 소유합니다. Viewer Core는 이 package를
import하지 않으며 Host event와 rendering lifecycle만 유지합니다.
