# 2D CAD Viewer 저장소 에이전트 지침

## 시작 전

상위 `../AGENTS.md`와 이 문서를 읽고 `dev` 브랜치인지 확인한다. 기존 사용자
변경이 있으면 그대로 보존하고 현재 작업과 섞지 않는다. 변경 영역에 따라 다음
문서를 먼저 읽는다.

- 제품 사용과 개발 진입점: `README.md`
- Viewer·제품 경계: `docs/architecture.md`
- engine 선택과 qualification: `docs/engine-decision.md`
- 배포와 branch 승격: `docs/distribution.md`
- MPL/GPL 경계: `docs/licensing.md`
- wire/cache contract: 관련 `specs/*.md`
- package admission: 관련 `compatibility/*.json`

## 저장소 책임

이 저장소가 소유하는 범위:

- source-neutral Viewer Core, Viewer UI와 render protocol
- WebGL presentation, camera, interaction, picking과 detail streaming
- DWG Scene Cache reader/writer contract와 native-document adapter
- process-isolated LibreDWG converter와 qualification
- standalone DWG Browser/VS Code 제품과 release artifact

이 저장소가 소유하지 않는 범위:

- IFC/BIM parser와 generic BIM exploration: `bim-explorer`
- consumer-specific Workspace, canonical authoring identity, revision/change와
  human authority
- account, billing, entitlement issuance와 commercial operation

Viewer Core는 DWG, IFC 또는 consumer 제품 구현을 직접 import하지 않는다.
consumer별 동작은 versioned contract, injected adapter와 conformance fixture로
표현한다. BIM 변경이 필요하면 공개 `bim-explorer` 이슈를 생성하거나
갱신한다. 그 밖의 consumer-specific 변경은 이 저장소에서 구현하지 않으며,
공개 이슈가 필요하면 아래 공개 이슈 규칙에 따라 이 저장소만의 독립 요구사항으로
작성한다. 현재 작업에서 다른 저장소를 수정하지 않는다.

## 구현 규칙

- protocol과 cache 변경에는 version, backward window, valid/invalid fixture와
  stale/failure 처리를 포함한다.
- renderer resource는 bounded allocation, atomic swap, rollback과 terminal
  disposal을 유지한다.
- source switch와 cancellation 뒤 process, range, CPU/GPU resource가 남지 않게
  한다.
- raw DWG 원본을 자동 변경하지 않고 converter와 Viewer process 경계를 지킨다.
- 성능이나 format 지원 주장은 재현 가능한 corpus/qualification evidence 범위를
  넘지 않는다.
- public package와 release artifact는 exact version, checksum, notice와 대응
  source를 유지한다.

## 공개 이슈 작성

이 저장소의 공개 이슈를 생성하거나 수정할 때 제목, 본문, 댓글, checklist,
첨부물과 log에 비공개 저장소명, 비공개 제품명, URL, 이슈·PR, commit, branch,
tag, package namespace, 내부 코드명과 roadmap을 기록하지 않는다.

비공개 요구에서 파생된 작업도 이 저장소가 독립적으로 소유하는 Viewer,
protocol, DWG 또는 adapter 결과만 기술한다. public 이슈에 private origin,
dependency, backlink나 양쪽 관계를 적지 않으며, 교차 링크는 비공개 저장소
쪽에만 둔다. 비공개 맥락 없이 정확하게 설명할 수 없으면 공개 이슈를 만들거나
갱신하지 않는다.

## 로컬 개발과 검증

Node.js 24, pnpm 11.12.0과 `rust-toolchain.toml`에 고정된 Rust 1.88.0을
사용한다.

```bash
pnpm install --frozen-lockfile
pnpm check
```

반복 작업 중에는 관련 workspace filter나 작은 검사를 먼저 실행한다.

```bash
pnpm test
pnpm run test:viewer-contracts
pnpm run test:webview
pnpm run test:vscode
```

native adapter, Windows Host, packaging 또는 release boundary를 변경하면
`package.json`과 관련 문서의 `qualify:*`, archive와 platform 검사를 추가로
실행한다. 현재 장비에서 실행하지 못한 플랫폼 검사는 완료로 간주하지 않는다.

## 데이터, 라이선스와 배포

- private/customer DWG, credential, 원본 파일명·경로·본문·handle과 민감한
  fingerprint를 커밋하거나 공개 evidence에 남기지 않는다.
- Viewer와 VS Code 범위의 MPL-2.0, LibreDWG converter와 대응 source의
  GPL-3.0-or-later 경계를 유지한다.
- third-party notice, source offer와 재배포 의무를 package 변경과 함께
  검토한다.
- 보안 취약점과 민감한 도면 발견은 공개 이슈 대신 저장소 보안 정책을 따른다.

일반 개발은 `dev`에서 수행한다. `dev`가 `prerelease`에 병합된 exact HEAD에서만
prerelease를 배포하고, `prerelease`가 `main`에 병합된 exact HEAD에서만 정식
release를 배포한다. `dev`에서 `main`으로 직접 승격하지 않는다. PR 생성,
미병합 종료, direct push, branch/tag 생성, 수동 workflow와 dry-run은 독립적인
배포 권한이 아니다. tag나 workflow가 배포 구현에 필요해도 앞선 병합으로
승인된 exact HEAD만 처리한다.

promotion 병합과 commit/push, tag, GitHub release, package, Marketplace 게시
또는 publication secret 사용은 사용자가 명시적으로 요청한 경우에만 수행한다.
긴급 수정도 `dev -> prerelease -> main` 순서를 따르고 세부 Gate는
`docs/distribution.md`를 따른다.

## 완료 보고

수정 파일, 실행한 Rust/Node 검사, protocol/cache/license와 downstream 영향,
실행하지 못한 platform Gate, 생성·갱신한 교차 저장소 이슈를 보고한다.
