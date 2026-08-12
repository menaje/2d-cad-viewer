# `@menaje/dwg-scene-source`

Scene Cache v1.26를 Viewer Core의 source-neutral `RenderSource` 계약에
연결합니다.

이 package가 소유하는 것은 다음과 같습니다.

- canonical `SceneCacheReader`
- Blob/HTTP/memory 기반 bounded range source
- immutable DWG base snapshot을 만드는 `DwgSceneCacheSource`
- session/revision/layer-bound Scene Cache range handle
- range request, cumulative read budget와 disposal

Webview의 기존 `src/scene-cache.mjs`와 `src/range-source.mjs`는 호환
re-export만 남아 있습니다. renderer, DOM, VS Code API, LibreDWG process와
실제 DWG path는 이 package에 포함하지 않습니다.

```js
import {
  BlobRangeSource,
  DwgSceneCacheSource,
  createSceneCacheRevisionId,
} from "@menaje/dwg-scene-source";

const source = new DwgSceneCacheSource({
  rangeSource: new BlobRangeSource(file),
  sessionId: "session:local-drawing",
  sourceId: "source:local-drawing",
  revisionId: createSceneCacheRevisionId(cacheSha256),
  cacheSha256,
  resourceBudgetBytes: file.size,
});
```

`cacheSha256`는 adapter/Host가 만든 SHA-256 형식의 cache fingerprint입니다.
session/revision/range binding을 위한 identity이며 cache 내용 전체의 무결성
증명으로 사용하지 않습니다. Source는 첫 화면 전에 전체 cache를 다시
읽지 않고, canonical reader로 header/version/directory와 각 요청 범위를
검증합니다. VS Code 제품은 변환 입력·엔진·옵션 cache ID를 사용하고,
standalone Browser는 파일 메타데이터와 앞·뒤 각 64KiB로 bounded session
fingerprint를 만듭니다.
