---
name: plannotator-review
description: >-
  Plannotator HTTP API로 plan/diff/annotate에 인라인 annotation만 등록하는 스킬.
  GET으로 본문을 읽고, 에이전트들로 심층 리뷰 후, external-annotations API로
  UI에 visible한 annotation들을 POST한다. 최종 approve/deny/feedback은 사용자가
  브라우저 UI에서 직접 결정하도록 hand-off. UI 드래그 시뮬레이션 없이 결정적.
when_to_use: >-
  사용자가 "plannotator 리뷰", "annotation만 달아줘", "UI에 피드백 남겨",
  "localhost:포트 리뷰", "외부 에이전트처럼 주석 달아" 같은 요청을 할 때.
  URL/포트 제공 또는 plannotator 실행 중일 때 활성화. annotation 등록 후에는
  사용자가 직접 approve/deny 버튼을 누를 수 있도록 hand-off.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Task
  - Question
  - TodoWrite
  - WebFetch
arguments:
  - port_or_url
  - mode_hint
---

# Plannotator API Review (Annotation-Only)

Plannotator HTTP API로 plan/diff/annotate에 annotation만 달고 멈춘다. 사용자가 UI에서 직접 approve/deny/send feedback을 누를 수 있게 hand-off한다.

## CRITICAL: Annotation 저장소 3종과 본문 하이라이트 조건

**세 가지 저장소**:

| 저장소 | 엔드포인트 | 사이드바 | 본문 하이라이트 | 용도 |
|--------|----------|---------|---------------------|------|
| Editor annotation | `/api/editor-annotation` | ❌ | ❌ | VS Code 확장 전용 |
| **External annotation** | `/api/external-annotations` | ✅ | ⚠️ **조건부** | 외부 도구(claude) — 이 스킬이 사용 |
| Internal annotation | UI 드래그 → `/api/draft` 자동 저장 | ✅ | ✅ 주황 밑줄 | 사용자 드래그 |

### 본문 하이라이트 메커니즘 (실측 확인 완료)

External annotation을 사이드바 + 본문 하이라이트 둘 다 띄우려면:

1. **플랜 로딩 후** `useExternalAnnotationHighlights` 훅이 작동
2. 필터 통과 조건: `type !== GLOBAL_COMMENT && originalText 존재`
3. `applyAnnotationsInternal` → `findTextInDOM(originalText)` 호출
4. DOM에서 substring 찾으면 `<mark>` 태그로 감쌈 (normalizer가 마크다운 처리)
5. 못 찾으면 콘솔 경고: `"Could not find text for annotation <uuid>: ..."`

### originalText 작성 규칙 (실측 기반)

**✅ 매칭되는 패턴**:
- 플랜 본문의 **단일 블록 내** 텍스트 (한 줄 or 한 문단 한 섹션)
- 마크다운 syntax 포함 가능 (`> **Summary**: ...` 도 OK — normalizer가 처리)
- 짧은 고유 단어 (`"Summary"`, `"foo"` 같은 unique substring)
- 불릿/체크박스 리스트의 visible text
- 헤더 텍스트 (H1-H6)

**❌ 매칭 실패하는 패턴**:
- **여러 블록 경계를 넘는** multi-line 텍스트 (예: 테이블 전체 + 캡션, 헤더 + 다음 bullet, 코드블록 전체)
- 플랜 본문에 **없는 텍스트** (오타, 번역, 요약 변형)
- 동일 텍스트가 **여러 번** 등장 (매칭 위치 불명확)

**💡 Best practice**:
- **한 annotation = 한 블록**. 블록 경계를 넘지 말 것
- 고유성 확보: 같은 단어가 여러 번 나오면 앞뒤 context 몇 글자 포함
- 너무 길게 X — 한 문단 내 핵심 구절로 제한 (300자 이내 권장)
- 매칭 실패는 **정상적인 fallback** — 사이드바 표시는 항상 유지되므로 리뷰 기능 손상 없음

### GLOBAL_COMMENT는 총평 전용

`type: "GLOBAL_COMMENT"` + `originalText: ""` → 플랜 상단에 총평으로 표시. 본문 하이라이트 불필요 (의도적 UX).

## Server Topology

Plannotator는 모드별로 다른 서버:

| Mode | Content GET | external-annotations 스키마 기반 |
|------|-------------|--------------------------------|
| **Plan** (submit_plan) | `GET /api/plan` | `originalText` 기반 (라인 번호 아님) |
| **Review** (diff) | `GET /api/diff` | `filePath + lineStart/End` 기반 |
| **Annotate** (문서) | `GET /api/plan` (with `mode:"annotate"`) | Plan과 동일한 `originalText` 기반 |

**모드 판별**: `GET /api/plan`에 `mode: "annotate"` 필드 있으면 annotate, 없으면 plan. `GET /api/diff` 성공하면 review.

## Phase 1: Server Discovery

### URL/포트 추출
사용자 입력에서 파싱: `http://localhost:56863`, `localhost:56863`, `:56863`, `56863` 모두 포트 `56863` 추출.

### 자동 탐색 (URL 안 준 경우)
```bash
# 프로세스 확인
ps aux | grep -iE 'plannotator|submit_plan' | grep -v grep

# Listening 포트 중 plannotator 후보
lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null | awk '$1 ~ /node|bun|plannotator/'
```
여러 개면 GET /api/plan 각각 쏴봐서 응답 오는 포트 식별. 없으면 Question 도구로 URL 요청.

### 모드 탐지
```bash
BASE="http://localhost:PORT"
curl -sf "$BASE/api/plan" > /tmp/plannotator-content.json && {
  MODE=$(python3 -c "import json; d=json.load(open('/tmp/plannotator-content.json')); print(d.get('mode','plan'))")
}
[ -z "$MODE" ] && curl -sf "$BASE/api/diff" > /tmp/plannotator-content.json && MODE=review
```

응답이 HTML(React 앱)이면 잘못된 라우트 — POST 엔드포인트도 mode-specific임을 기억.

## Phase 2: Content Review

### Plan 모드
- `plan` 필드: 전체 마크다운
- `versionInfo`: `{version: N, totalVersions: M, project: "..."}`
- `previousPlan`: v{N-1} 플랜 (있으면 **iteration-aware 리뷰**: 이전 피드백 반영 여부 검증)
- `projectRoot`: 관련 코드베이스 루트 (에이전트 탐색 시 `workdir`로 사용)
- `origin`: `"opencode"` | `"claude-code"` 등

### Review 모드
- `GET /api/diff`의 diff 본문 + 파일 목록
- 필요 시 `GET /api/file-content?path=...`로 맥락 확장

### 에이전트 분배
리뷰 규모별:
- **소/명확**: Claude 직접 리뷰
- **중**: `explore` 2-3개 병렬 (코드 정합성, 테스트 커버리지, 컨벤션)
- **대/복잡**: `oracle` 추가 (아키텍처, race condition, scope drift)
- **외부 컨텍스트 필요**: `librarian` + Jira MCP + Notion MCP 병렬

**v{N≥2} 리뷰의 경우**: 이전 버전 피드백이 정확히 반영됐는지 우선 확인. 해결된 항목은 positive annotation으로 acknowledge.

## Phase 3: Annotation Posting

### Plan / Annotate 모드 스키마

**REQUIRED**:
- `source`: string (non-empty) — 출처 도구명. 이 스킬은 `"claude"` 사용
- `text`: string (non-empty) — annotation 본문

**OPTIONAL**:
- `type`: `"GLOBAL_COMMENT"` (default) | `"COMMENT"` | `"DELETION"`
- `originalText`: string — plan 본문 내 하이라이트할 **정확한 substring** (DELETION 타입은 REQUIRED)
- `author`: string — 작성자 표시명

**핵심 차이점**: Plan 모드는 **라인 번호가 아니라 substring 매칭**이다. `originalText`가 plan 본문에 정확히 존재해야 UI에서 하이라이트됨.

**annotation 타입 사용 가이드**:
- `GLOBAL_COMMENT`: 전체 플랜 대상 총평 (`originalText` 없이)
- `COMMENT`: 특정 구절에 코멘트 (`originalText` 필요)
- `DELETION`: 제거 제안 (`originalText` 필수, text는 사유)

### Review 모드 스키마

**REQUIRED**:
- `source`: string
- `filePath`: string
- `lineStart`: number
- `lineEnd`: number
- `text` 또는 `suggestedCode` 중 최소 하나

**OPTIONAL**:
- `type`: `"comment"` (default) | `"suggestion"` | `"concern"`
- `side`: `"new"` (default) | `"old"` — diff 어느 쪽
- `scope`: `"line"` (default) | `"file"`
- `originalCode`: string — 수정 전 코드
- `author`: string

### POST 엔드포인트

**단건**:
```bash
curl -sX POST "http://localhost:PORT/api/external-annotations" \
  -H 'Content-Type: application/json' \
  -d '{"source":"claude","type":"COMMENT","originalText":"...","text":"..."}'
```

**배치** (권장):
```bash
curl -sX POST "http://localhost:PORT/api/external-annotations" \
  -H 'Content-Type: application/json' \
  -d '{"annotations":[{"source":"claude",...},{"source":"claude",...}]}'
```

**응답**: `201 Created` + `{"ids": ["<uuid>", ...]}`

### 헬퍼 스크립트 패턴 (Plan 모드)

Heredoc + 파이프 충돌 방지: `/tmp/`에 Python 스크립트 저장 후 실행.

```python
import json, urllib.request

PORT = <port>

with open('/tmp/plannotator-content.json') as f:
    plan = json.load(f)['plan']

ANNOTATIONS = [
    {
        "source": "claude",
        "type": "GLOBAL_COMMENT",
        "text": "✅ v1/v2 피드백 12개 모두 정확히 반영됨. 승인 권장."
    },
    {
        "source": "claude",
        "type": "COMMENT",
        "originalText": "Critical Path: 1 → 2 → 3 → (4 ∥ 5) → 6 → F1-F4",
        "text": "✅ (4 ∥ 5) 병렬 표기 수정. Task 5 누락 문제 해소."
    },
    {
        "source": "claude",
        "type": "COMMENT",
        "originalText": "Blocked By: [3, 4]",
        "text": "✅ v2에서 [3]만이었던 것에서 Task 4 dependency 추가."
    },
]

for ann in ANNOTATIONS:
    if "originalText" in ann and ann["originalText"] not in plan:
        print(f"WARN: originalText not in plan, skipping: {ann['originalText'][:60]}...")
        continue

payload = {"annotations": ANNOTATIONS}
req = urllib.request.Request(
    f'http://localhost:{PORT}/api/external-annotations',
    data=json.dumps(payload).encode('utf-8'),
    headers={'Content-Type': 'application/json'},
    method='POST',
)
with urllib.request.urlopen(req, timeout=5) as resp:
    body = json.loads(resp.read())
    print(f"Registered {len(body.get('ids', []))} annotations")
```

**중요**: `originalText`는 plan 본문에 **정확히 매칭되어야 함** (줄바꿈, 공백, 특수문자 포함). POST 전에 `if originalText in plan` 검증 필수. 매칭 안 되면 UI에서 하이라이트 안 되고 orphan 상태.

### 헬퍼 스크립트 패턴 (Review 모드)

```python
ANNOTATIONS = [
    {
        "source": "claude",
        "type": "concern",
        "filePath": "src/foo.ts",
        "lineStart": 42,
        "lineEnd": 48,
        "side": "new",
        "scope": "line",
        "text": "이 분기에서 null 체크 누락",
        "suggestedCode": "if (x !== null) { ... }"
    },
]
```
동일하게 batch POST.

### 검증

```bash
# GET으로 등록 확인
curl -s "http://localhost:PORT/api/external-annotations" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('registered:', len(d.get('annotations', [])))"
```

SSE 스트림(`/api/external-annotations/stream`)을 통해 **사이드바에 실시간 표시**되므로 페이지 새로고침 불필요. 단, 본문 inline 하이라이트는 안 됨 (CRITICAL 섹션 참조).

### Quick Label 컨벤션 (선택사항)

Plannotator UI의 Quick Label 버튼(⚡)이 정의하는 10가지 표준 리뷰 카테고리. External API는 `isQuickLabel` 플래그나 컬러 바 설정을 지원하지 않지만, **`text`에 emoji prefix만 붙이면 사이드바에서 동일한 시각적 분류 효과**를 얻을 수 있음.

```python
QUICK_LABELS = {
    "clarify":      ("❓", "Clarify this",              None),
    "overview":     ("🗺️", "Missing overview",          "상위 narrative overview (무엇을/왜/어떻게)를 구현 세부보다 먼저 배치"),
    "verify":       ("🔍", "Verify this",               "가정 같으니 실제 코드를 읽고 검증한 뒤 진행"),
    "example":      ("🔬", "Give me an example",        "너무 추상적 — before/after, 입/출력 샘플, 구체 시나리오 제시"),
    "patterns":     ("🧬", "Match existing patterns",   "기존 패턴/유틸 탐색 후 재사용, 새 접근 도입은 자제"),
    "alternatives": ("🔄", "Consider alternatives",     "2-3개 대안 + trade-off 제시. ~/.plannotator/plans/ 이전 버전도 참조"),
    "regression":   ("📉", "Ensure no regression",      "기존 동작 깨짐 검증, 회귀 가능 지점과 방어법 식별"),
    "scope":        ("🚫", "Out of scope",              "현재 작업 범위 밖 — 제거하고 요청된 범위에만 집중"),
    "tests":        ("🧪", "Needs tests",               None),
    "nice":         ("👍", "Nice approach",             None),
}

def quick_label_text(key: str, detail: str | None = None) -> str:
    emoji, label, _ = QUICK_LABELS[key]
    base = f"{emoji} {label}"
    return f"{base}: {detail}" if detail else base
```

사용 예:
```python
{"source": "claude", "type": "COMMENT",
 "originalText": "event.image_path is None",
 "text": quick_label_text("verify", "실제 DB에서 null인 경우 얼마나 되나?")}
# → text: "🔍 Verify this: 실제 DB에서 null인 경우 얼마나 되나?"
```

**중요**: Quick Label은 **의미적 분류 컨벤션일 뿐** 필수는 아님. 일반 COMMENT로 텍스트만 써도 충분. 리뷰 톤을 일관되게 전달하고 싶을 때만 사용.

### 사이드바 UX 끌어올리는 기타 팁

1. **annotation 순서 = 플랜 진행 순서**: 위→아래 순서로 POST하면 사용자 선형 스캔 편함
2. **GLOBAL_COMMENT로 "총평 + 인덱스"**: 첫 annotation에 리뷰 포인트 전체 맵
   - 예: `"총평: 승인 권장. 상세 코멘트 6개 — TL;DR 1건, Work Objectives 2건, TODOs 3건"`
3. **긴 설명은 `text` 본문에**, 헤더 한 줄은 **emoji prefix**로
4. **`originalText`는 고유한 구절** — 플랜 내 unique해야 매칭 안정

## Phase 4: Hand-off to User (approve/deny 자동 제출하지 않음)

**이 스킬의 핵심 동작**: annotation 등록 후 즉시 멈춘다. 사용자가 브라우저에서 직접 결정.

보고 템플릿:

```markdown
✅ **Plannotator annotation 등록 완료**

**서버**: http://localhost:<PORT> (mode: <plan|review|annotate>)
**등록된 annotation**: <N>개
  - <타입별 수 요약>
  - GLOBAL_COMMENT: 전체 판정
  - COMMENT × N: 각 지점 피드백
  - concern × N (review 모드인 경우)

**주요 리뷰 포인트**:
1. <핵심 판정 한 줄>
2. <주요 강점/우려 요약>
3. <다음 단계 제안>

---

🖐️ **다음 단계는 사용자가 직접 결정해주세요**:
- 브라우저의 plannotator UI에서 annotation 확인
- 내용에 동의하면 → **Approve** (Plan 모드) / **Send Feedback** (Review 모드)
- 수정이 필요하면 → **Deny** + 추가 코멘트 (Plan 모드)
- annotation을 삭제/수정하려면 UI에서 직접 편집

(이 스킬은 의도적으로 approve/deny를 자동 제출하지 않습니다. 최종 결정권은 사용자에게 있습니다.)
```

## Arguments

- `$1` (`port_or_url`): `56863`, `:56863`, `http://localhost:56863` 중 하나
- `$2` (`mode_hint`, optional): `plan` | `review` | `annotate` | `auto` (기본: auto)

## Usage Examples

```
# URL 직접 지정
@plannotator-review http://localhost:56863

# 포트만
@plannotator-review 56863

# 자동 탐색
@plannotator-review

# 자연어 트리거
"plannotator 56863에 annotation만 달아줘"
"v3 리뷰 annotation만 등록, approve는 내가 할게"
"UI에 피드백 남겨줘 localhost:56863"
```

## Decision Heuristics

### Annotation 수 & 타입
- **플랜이 깔끔/승인 적합**: GLOBAL_COMMENT 1개 (총평) + COMMENT 3-8개 (강점 하이라이트) = 4-9개
- **수정 필요**: GLOBAL_COMMENT 1개 (거부 사유 요약) + COMMENT 3-6개 (각 blocker 지점)
- **Nit만 있음**: GLOBAL_COMMENT 1개 (승인 권장) + COMMENT 2-4개 (작은 개선점)
- **너무 많이 달지 말 것**: 10개 넘어가면 signal 희석. 한 지점에 하나씩만.

### originalText 선택 팁 (Plan 모드)
- **고유한 텍스트**를 선택 (plan에 단 한 번만 등장하는 문구)
- 너무 짧으면 (< 20자) 매칭 애매, 너무 길면 (> 200자) UI 뭉개짐
- 마크다운 특수문자(`|`, `*`, ``` ` ```) 포함해도 OK — 서버가 그대로 매칭
- 줄바꿈 포함 가능 (`\n`으로 정확히 맞춰야 함)

### type 선택 (Plan 모드)
- **GLOBAL_COMMENT**: 전체 판정, 총평, 요약. `originalText` 생략
- **COMMENT**: 특정 구절/섹션에 대한 의견. `originalText` 필요
- **DELETION**: "이 부분 빼세요" 제안. `originalText` 필수, `text`에 사유

### type 선택 (Review 모드)
- **comment**: 정보성 의견
- **suggestion**: 구체적 수정안 (`suggestedCode` 권장)
- **concern**: 잠재 문제/버그 (가장 강한 톤)

## Error Handling

| 증상 | 원인 | 대응 |
|------|------|------|
| HTML 응답 | 잘못된 라우트 (SPA fallback) | 모드 재탐지, 엔드포인트 재확인 |
| `{"error":"...missing required \"text\""}` | `text` 필드 누락 | payload에 text 포함 |
| `{"error":"...DELETION type requires...originalText"}` | DELETION인데 originalText 없음 | originalText 추가 또는 type을 COMMENT로 |
| `{"error":"invalid type..."}` | Plan에 review 타입 썼거나 vice versa | 모드 매칭 재확인 |
| **사이드바엔 뜨는데 본문 하이라이트 안 됨** | `originalText`가 **블록 경계를 넘음** (multi-line 테이블 전체 등) | 각 블록별로 annotation 분할 |
| 본문 하이라이트 안 되고 콘솔에 `Could not find text for annotation` | `originalText`가 DOM에 실제로 없음 (플랜 변형/오타) | plan 콘텐츠 재확인, exact substring 사용 |
| 하이라이트가 엉뚱한 위치에 | 동일 텍스트가 여러 번 등장 | 앞뒤 context 몇 글자 포함해 유일성 확보 |
| 연결 거부 | plannotator 종료 | 사용자에게 재실행 요청 |

### 매칭 실패 디버깅 워크플로

1. **브라우저 DevTools → Console** 열기
2. `"Could not find text for annotation"` 검색 → 실패한 annotation ID 확인
3. 해당 `originalText`가 `findTextInDOM`으로 찾을 수 있는 형태인지 확인:
   - 단일 블록 내에 있는가?
   - DOM에 정확히 렌더되는가? (마크다운 파서 동작 주의)
4. 실패해도 **사이드바 표시는 유지** — 리뷰 기능 자체는 무손상

## CRITICAL RULES

- **approve/deny/feedback 절대 자동 제출 금지** — annotation만 달고 사용자에게 hand-off.
- **`/api/editor-annotation` 절대 사용 금지** — VS Code 전용이라 UI에 안 보임. 항상 `/api/external-annotations`.
- **`source` 필드 필수** — 빈 문자열이면 400. 이 스킬은 항상 `"claude"` 사용.
- **Plan 모드는 `originalText` 기반**, Review 모드는 `filePath + lineStart/End` 기반 — 섞지 말 것.
- **`originalText` plan 본문 매칭 검증** — POST 전에 `if original_text in plan` 확인. 매칭 안 되면 orphan.
- **UI 드래그 시뮬레이션 금지** — playwright로 `window.getSelection()` 조작은 느리고 불안정. HTTP API만.
- **Heredoc + 파이프 금지** — `curl … | python3 << 'PY'`는 stdin 충돌. 항상 `/tmp/` 임시 파일 경유.
- **annotation 중복 방지** — 재시도 전 `GET /api/external-annotations`로 기존 확인, 필요 시 `DELETE /api/external-annotations?id=<uuid>` 또는 `?source=claude`로 batch 제거.
- **iteration-aware 리뷰** — `previousPlan` 필드 있으면 이전 피드백 반영 여부 우선 확인.
- **annotation은 signal, feedback은 context** — annotation `text`는 1-3문장. 긴 설명은 채팅 응답으로.

## Integration with Other Skills

- **`/start-work-jira`**: 사용자가 approve 누른 후 이어서 실행
- **Jira MCP** (`getJiraIssue`, `searchJiraIssuesUsingJql`): 티켓 컨텍스트 주입
- **Notion MCP** (`Notion_MCP_notion-fetch`): 프로젝트 문서 참조
- 자매 스킬 (미래): `plannotator-approve` (사용자가 "approve 눌러줘" 했을 때만 동작) / `plannotator-deny` (deny + detailed feedback)
