# `@menaje/viewer-render-protocol`

Viewer Core가 raw Scene Cache source와 Service-backed source를 같은 경계에서
열기 위한 source-neutral 계약입니다.

현재 `0.1.2`는 checksum-pinned GitHub Release와 GitHub Packages에 배포되는
public preview contract이며 다음을 검증합니다.

- exact semantic-version negotiation
- opaque session/source/revision identity
- current revision과 last-successful revision 분리
- generic 2D/3D/semantic layer manifest
- session/revision/layer에 묶인 bounded range handle
- 같은 snapshot layer에 묶인 pick request와 Render/Pick identity
- nullable opaque external identity token
- 만료 또는 session disposal scope를 가진 Context Reference와 source reveal
- base snapshot/from/to revision과 monotonic sequence에 묶인 atomic Render Delta
- entity tombstone과 geometry/text/transform/style/identity/dependency upsert
- operation별 affected world bounds와 bounded binary payload descriptor
- ordered available/failed revision event와 last-successful snapshot 보존
- revision/snapshot/layer에 묶인 bounded diagnostic batch
- stale revision, scope mismatch와 unknown field의 fail-closed 처리

## 설치

공개 Release artifact는 인증 없이 설치할 수 있습니다. 파일명과 SHA-256은
저장소의 `compatibility/viewer-core.json`에 고정되어 있습니다.

```sh
npm install https://github.com/menaje/dwg-viewer/releases/download/viewer-core-v0.1.2/menaje-viewer-render-protocol-0.1.2.tgz
```

GitHub Packages를 사용할 때는 `@menaje` scope를
`https://npm.pkg.github.com`에 연결하고 exact `0.1.2`를 설치합니다.

이 package는 Spatial Workspace, Agent method, credential, 실제 file path와
기존 `dwg-*` Host–Webview message를 포함하지 않습니다.
`diff.open`과 `humanAction.request`는 ViewerHost intent/event이며 source가
authority를 선언하는 Render capability가 아닙니다.

```js
import {
  RenderCapability,
  RenderProtocolVersion,
  parseRenderSessionDescriptor,
} from "@menaje/viewer-render-protocol";

const descriptor = parseRenderSessionDescriptor({
  protocolVersion: RenderProtocolVersion,
  sessionId: "session:local-drawing",
  sourceId: "source:drawing",
  currentRevisionId: "revision:sha256:...",
  lastSuccessfulRevisionId: "revision:sha256:...",
  capabilities: [
    RenderCapability.LAYER_MANIFEST,
    RenderCapability.RENDER_SNAPSHOT,
  ],
  resourceBudgetBytes: 512 * 1024 * 1024,
});
```

`pick.resolve` 결과는 world position/bounds와 optional external identity를
포함하지만 실제 file path, credential 또는 Service graph object는 포함할 수
없습니다. external identity가 없는 source는 token을 `null`로 명시합니다.
Context와 source reveal은 Host가 임의 경로를 받는 대신 session-bound opaque
ID를 전달받도록 설계되어 있습니다.

Render Delta는 source-specific geometry object나 GPU byte diff를 public
semantic change로 사용하지 않습니다. 각 operation은 Render ID와 변경
aspect만 설명하며 실제 renderer packet은 session budget, digest,
expiration/disposal scope를 가진 opaque binary payload로 분리됩니다. 한
atomic delta에서 같은 layer/Render ID를 두 번 변경하거나 전체 affected
bounds 밖의 operation을 선언할 수 없습니다.

동일한 envelope가 `3d` layer의 retained geometry range에도 사용됩니다.
geometry, transform, style(가시성 포함), identity, dependency와 entity
tombstone은 기존 aspect로 구분하고 mesh/primitive/GPU range 같은
source-specific 필드는 payload media type 내부에 둡니다. valid/invalid 3D
fixture가 이 경계를 검증하므로 wire protocol version은 `0.1.0` 그대로입니다.

현재 계약은 snapshot/delta, preview overlay, Service revision/diagnostics
stream 기반을 제공합니다. 실제 WebGL packet layout과 visual diff 표현은
renderer adapter와 제품 UI가 소유합니다.
