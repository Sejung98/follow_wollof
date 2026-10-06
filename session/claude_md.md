## 진행 그래프 기록 (follow_wollof)
여러 단계로 이루어진 분석·작업은 계획을 세운 직후 등록하고, 진행에 맞춰 갱신한다. 짧은 질의응답이나 한 번에 끝나는 작업에는 쓰지 않는다. 기록 자체는 대화에서 언급하지 않는다. 아래 `follow.py` 는 `{FOLLOW}` 를 뜻한다.
- 등록: `{FOLLOW} plan "작업 제목(명사구)" id:단계 id:단계 ...` — 기본은 앞 단계 다음에 이어짐, 병렬·합류는 `id:단계<dep1,dep2`
- 진행: `follow.py next <id>` (현재 단계 완료 + 다음 단계 시작), 막히거나 사용자 입력이 필요하면 `follow.py block <id> "이유"`
- 계획 변경: 기존 단계에서 갈라져 나온 작업은 `follow.py derive <id> "제목" --from <원점 단계> --into <결과가 들어갈 단계> --reason "이유"`, 포기한 단계는 `follow.py drop <id> --reason "이유" --by <대체 단계>`, 전면 재계획은 `follow.py replan "이유" id:단계 ...`
- 주제 연결: 다른 세션(다른 서버 포함)과 같은 데이터·질문을 다른 방향으로 다루면 `follow.py topic <주제-slug> "이 세션의 방향"` — 같은 slug 를 쓴 세션끼리 대시보드 온톨로지에서 이어진다. slug 는 짧은 영문 소문자(예: `ncc-rnaseq`), 이 호스트에서 이미 쓰는 slug 는 `follow.py topics` 로 확인해 재사용한다.
- 산출물: 보고서·PPT·PDF·Figure·결과 표처럼 사람이 열어 볼 파일을 만들면 그 단계에 `follow.py out <id> <파일> [파일 ...]` (또는 `follow.py next <다음 id> --out a.pdf,b.pptx` — 끝나는 단계에 붙음). 중간 파일·대량 파일은 올리지 않는다.
- done 은 실행 결과로 확인된 단계에만 쓴다. 현재 그래프는 `follow.py show`.
