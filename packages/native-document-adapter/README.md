# Native document adapter

`@dwg-viewer/native-document-adapter`는 DWG의 source-precision query와
change/Save As 판정을 renderer 및 상위 Workspace 권한에서 분리합니다.
계약 ID는 `dwg-native-document-adapter/0.1.0`입니다.

현재 제품 상태는 `query-preview`입니다.

- LibreDWG Native가 만든 Scene Cache v1.24 source record를 bounded range로
  읽어 handle/owner/layer/bounds만 packed typed array index에 저장합니다.
- query 결과는 source fingerprint, space, nested instance path, native
  handle과 entity fingerprint에 묶입니다.
- region query는 exact/conservative bounds를 구분하고 bounds를 만들 수
  없는 complex record 수를 숨기지 않습니다.
- 전체 DWG object graph, LibreDWG pointer와 실제 파일 경로를 JavaScript
  결과로 노출하지 않습니다.
- 현재 LibreDWG writer qualification이 실패했으므로 모든 change/write와
  reopen capability는 `blocked`입니다. output capability를 예약하거나
  파일을 만들기 전에 거부합니다.
- WASM MEMFS 후보는 기존 800MB memory hard gate와 Chromium 실행 Gate를
  통과하지 못했으므로 제품 backend가 아닙니다.

지원 상태와 evidence는
[`compatibility/native-document-adapter.json`](../../compatibility/native-document-adapter.json),
전체 계약은
[`specs/native-document-adapter.md`](../../specs/native-document-adapter.md)에
있습니다.

검증:

```bash
pnpm --filter @dwg-viewer/native-document-adapter check
pnpm run qualify:native-document-adapter
```

reference writer fixture는 no-op Save As와 변경 후 reopen 결과가 intended
diff와 정확히 같은지를 계약 수준에서 검증합니다. 이는 실제 LibreDWG
writer를 제품에 허용한다는 뜻이 아닙니다.
