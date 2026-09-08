# `@menaje/viewer-ui`

Viewer의 source-neutral DOM composition package입니다. Viewer Core의
renderer/source lifecycle과 분리되어 있으며 DWG Scene Cache, VS Code API,
host workspace 또는 제품별 selection record를 import하지 않습니다.
0.1.3 public preview는 Viewer Core와 함께 checksum-pinned GitHub Release
artifact 및 GitHub Packages package로 배포됩니다.

```sh
npm install https://github.com/menaje/2d-cad-viewer/releases/download/viewer-core-v0.1.3/menaje-viewer-ui-0.1.3.tgz
```

`ViewerReviewUiController`는 다음을 소유합니다.

- review toolbar의 활성 도구와 `aria-pressed` 상태
- 다점 도구의 완료 버튼 표시
- toolbar/result action event binding과 idempotent disposal
- bounded result view model의 text-only DOM rendering
- generic result action과 product-owned data attribute projection
- revision-bound added/removed/modified/unchanged diff summary projection

DWG 후보 탐색, CAD 속성 이름, 측정 계산과 layer action 의미는
`packages/webview` adapter에 남습니다. 다른 제품은 자신의 selection을
`title`, `rows`, `actions` view model로 투영해 같은 controller를 사용할 수
있습니다. `createViewerDiffResultModel()`은 Core의 bounded net diff summary를
기존 text-only result panel에 투영하며 제품이 원하는 locale label을
주입받습니다. before/after 논리 카메라 동기화는 Viewer Core가 제공하지만,
상태별 overlay 색상·opacity·visibility 정책도 Viewer Core가 제공합니다.
실제 shader/Canvas 적용 adapter는 renderer가 소유합니다.

`ViewerSplitViewUiController`는 제품이 주입한 서로 다른 before/after surface를
실제 접근 가능한 DOM split layout으로 구성합니다. horizontal/vertical 방향,
10–90% bounded divider, keyboard/pointer resize, label/visibility와 listener
lifecycle을 소유하며 disposal 시 두 surface를 원래 DOM 위치에 정확히
복원합니다. Core의 camera/diff controller와 renderer lifecycle은 소유하지
않으므로 각 surface는 독립적인 revision, GPU/detail state와 canvas 비율을
유지합니다.

이 package는 DOM bootstrap을 만들지 않습니다. 제품 shell이 이미 소유한
surface, toolbar와 result element를 주입하며, controller disposal 후에는
다시 사용할 수 없습니다.
