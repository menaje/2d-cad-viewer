---
{"schemaVersion":"1.1.0","documentId":"CONI-VIEWER-SPEC-NATIVE-DOCUMENT-ADAPTER-0-1","title":"Native Document Adapter Protocol v0.1","type":"specification","version":"0.1.0","status":"draft","normativity":"normative","authority":["viewer-native-document-adapter-contract"],"visibility":"public","supersedes":[],"lastReviewed":"2026-08-30","effectiveAt":"2026-08-30","extensions":{"repository":"viewer","documentRole":"normative-specification"}}
---

# Native document adapter protocol v0.1

Status: query-preview; production mutation and writer blocked.

Protocol:

```text
dwg-native-document-adapter/0.1.0
```

이 계약은 raw DWG의 bounded query와 안전한 change/Save As 판정을
Viewer renderer, Scene Cache 표시 상태와 상위 Workspace authority에서
분리합니다. adapter session은 source of truth나 영구 ChangeSet을 소유하지
않습니다.

## Process and authority boundary

```text
registered input capability
  + expected source fingerprint
  -> native-process or qualification-only wasm-worker
       -> packed native query index
       -> validated change proposal
       -> exclusive new output capability
       -> independent reopen receipt
```

public request에는 등록된 opaque input/output capability ID만 들어갑니다.
실제 path는 Host 내부 registry에 남으며 원본과 output이 같은 capability이면
`DWG_NATIVE_OUTPUT_CONFLICT`로 거부합니다. adapter는 임의 path를 받거나
원본을 덮어쓰지 않습니다.

Viewer selection, Render ID와 Scene Cache ID는 native mutation authority가
아닙니다. change target은 다음 exact reference를 사용합니다.

```text
source SHA-256 fingerprint
+ model/layout/block space ID
+ bounded nested INSERT handle path
+ uppercase native DWG handle
+ semantic entity SHA-256 fingerprint
```

source 또는 entity fingerprint가 다르면 각각
`DWG_NATIVE_STALE_SOURCE`, `DWG_NATIVE_STALE_ENTITY`로 fail-closed합니다.

## Descriptor and capabilities

session descriptor는 protocol/session/adapter/engine/backend/license,
source fingerprint, registered input capability, source/output DWG version,
resource limit와 모든 operation 상태를 포함합니다.

상태:

```text
native
mapped
opaque
lossy
blocked
```

operation:

```text
read
query-entity
query-region
change-text
change-line-polyline
change-layer-style
change-insert-transform
create-delete-basic-entity
write-dwg
write-dxf
preserve-unsupported
reopen-validate
```

`native`와 `mapped`만 실행할 수 있습니다. `opaque`, `lossy`, `blocked`는
이유와 함께 operation 시작 전에 거부합니다. 제품이 제한을 조용히
낮추거나 writer 성공을 추측하지 않습니다.

## Packed query index

현재 Native query provider는 Scene Cache v1.26의 source-precision record를
최대 512KiB씩 읽습니다. handle/owner, section locator, layer, bounds와
bounds precision만 parallel typed array에 저장하며 entity별 JavaScript
object graph를 만들지 않습니다.

기본 상한:

| 항목 | 상한 |
| --- | ---: |
| index entries | 1,000,000 |
| scanned source record bytes | 256 MiB |
| one source range | 512 KiB |
| one query page | 256 entities |
| one query response | 1 MiB |
| nested instance depth | 32 |

LINE, POINT, SOLID와 3DFACE는 exact bounds를 사용합니다. ARC, CIRCLE,
ELLIPSE, text와 image plane은 누락을 피하기 위한 conservative bounds를
사용합니다. INSERT, POLYLINE, SPLINE과 HATCH처럼 현재 record 하나만으로
안전한 bounds를 만들 수 없는 entity는 region 결과에서 제외하되
`unindexedEntries`로 보고합니다.

region pagination cursor는 session과 query bounds/type에 묶입니다. 다른
source/session/query에 재사용하면 거부합니다. entity fingerprint는 실제
packed source record bytes와 source fingerprint로 계산하므로 stale handle
재사용을 허용하지 않습니다.

## Change proposal

proposal은 다음 precondition을 항상 포함합니다.

- exact protocol과 proposal ID
- expected source fingerprint
- registered input capability ID
- 원본과 다른 registered output capability ID
- `dwg` 또는 `dxf` output format과 허용 version
- 최대 256개의 unique operation ID
- 전체 1MiB, operation payload 64KiB 상한

초기 schema:

| kind | target | bounded payload |
| --- | --- | --- |
| `text.replace` | TEXT/MTEXT/ATTDEF/ATTRIB ref | UTF-8 value |
| `line.move` | LINE ref | finite XYZ translation |
| `polyline.move` | POLYLINE ref | finite XYZ translation |
| `layer-style.set` | entity ref | layer/color/lineweight/linetype |
| `insert-transform.set` | INSERT ref | finite 4×4 matrix |
| `basic-entity.create` | null | LINE/LWPOLYLINE/TEXT geometry |
| `basic-entity.delete` | entity ref | empty payload |

proposal validation은 output을 예약하기 전에 source/version/operation
capability와 모든 target entity fingerprint를 다시 확인합니다.

## Save, reopen, and preservation receipt

writer 함수의 반환만으로 성공하지 않습니다. admitted backend는 새 output을
exclusive로 만들고 별도 reopen validator 결과를 다음 receipt에 묶어야
합니다.

```text
dwg-native-change-receipt/1
  source/output fingerprint
  adapter/backend/output version
  intended normalized changes
  reopened observed normalized changes
  unsupported/Korean/font/block/XREF/layout/draw-order preservation
  independent reopen engine
  process/Worker/temp/output-reservation cleanup
```

`intended`와 `observed`는 operation 순서와 의미가 정확히 같아야 합니다.
다르면 output은 제품 결과로 채택하지 않고
`DWG_NATIVE_OBSERVED_DIFF_MISMATCH`를 반환합니다.

실제 writer admission 순서는 no-op Save As, LINE, TEXT/MTEXT, layer/style,
INSERT, basic create/delete, unsupported/custom preservation, 다른 engine 및
외부 CAD open/regen입니다. 하나라도 불합격이면 해당 operation/version은
pre-write `blocked`로 남습니다.

## Progress, cancellation, and cleanup

progress event schema는 `dwg-native-adapter-progress/1`, error schema는
`dwg-native-adapter-error/1`입니다. progress는 session sequence와 operation
ID에 묶이고 `validating`, `querying`, `writing`, `reopening`, `complete`,
`failed`, `cancelled` phase를 사용합니다.

모든 query/write provider call은 `AbortSignal`을 전달받습니다. dispose는
idempotent하며 다음 값이 모두 닫힌 receipt만 성공으로 인정합니다.

- remaining temporary files = 0
- remaining output reservations = 0
- Native process exited 또는 WASM Worker terminated

## Current product decision

2026-08-04 기준:

- Native `read`는 `native`, handle/region query는 Scene Cache projection
  의미를 명시한 `mapped`입니다.
- 실제 LibreDWG 0.14 no-op writer preservation qualification이 실패했으므로
  모든 mutation, write, preserve와 reopen operation은 `blocked`입니다.
- reference writer만 계약 자체의 no-op/change/reopen intended-observed
  validation을 실행합니다.
- 현재 WASM MEMFS 후보는 최대 관찰 RSS 2,983,854,080 bytes로 800MB hard
  limit를 초과했고 Chromium small fixture도 30초 안에 끝나지 않아
  `rejected`입니다.
- MPL VSIX에는 GPL-linked adapter를 포함하지 않습니다. Native adapter는
  complete corresponding source와 함께 별도 GPL artifact로만 배포합니다.

기계 판독 상태와 재현 명령은
[`compatibility/native-document-adapter.json`](../compatibility/native-document-adapter.json)에
있습니다.
