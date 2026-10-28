# follow_wollof

[English](README.md)

여러 컴퓨터·서버에서 동시에 돌아가는 Claude Code 세션들이 **각자 세운 작업 계획 중 지금 어느 단계에 있는지**를 한 화면의 그래프로 실시간으로 보여주는 대시보드입니다. 계획이 중간에 바뀌면 새 단계가 어느 단계에서 갈라져 나왔고 결과가 어느 단계로 합류하는지도 그래프에 남습니다.

```
 각 호스트 (local / ssh 서버)                         대시보드를 띄운 컴퓨터
 Claude 세션 ── follow.py ──> ~/.follow_wollof/       fw  →  server/app.py  →  브라우저 localhost:7777
 ~/.claude/sessions (Claude Code 기본 제공)    ──ssh──>  호스트마다 감시 스크립트 1개를 stdin 으로 보내 실행
```

- 세션 쪽: 여러 단계 작업을 시작하면 Claude 가 `follow.py` 로 계획과 진행 단계를 기록합니다 (전역 CLAUDE.md 안내 + 기록이 빠졌을 때만 알려주는 Stop 훅).
- 대시보드 쪽: 각 호스트에 ssh 연결을 하나씩 유지하며 변화를 받아 그래프로 그립니다. 원격 호스트에는 대시보드용 프로그램을 설치하지 않습니다.

## 계획이 화면에 오기까지

1. **기록** — 세션의 Claude 가 계획을 세우거나 단계를 옮길 때 `follow.py` 를 실행합니다. 명령 한 번이 `~/.follow_wollof/sessions/<세션ID>/events.jsonl` 에 이벤트 한 줄(`plan` · `next` · `derive` · `drop` · `replan` · `state`)로 덧붙습니다. 지우거나 고치지 않으므로 계획이 바뀐 과정이 그대로 남습니다. 세션 ID 는 Claude Code 가 넣어 주는 환경변수 `CLAUDE_CODE_SESSION_ID` 로 압니다.
   - 누가 실행시키나: 전역 CLAUDE.md 블록(여러 단계 작업이면 기록하라는 안내), Stop 훅(턴이 끝났는데 기록이 빠졌으면 한 번 알림), `/follow` 스킬(수동 정리).
2. **수집** — 각 호스트에서 `agent.py` 가 2초마다 Claude Code 가 실행 중인 세션마다 만드는 `~/.claude/sessions/<pid>.json` 을 읽어, 프로세스가 살아 있는 세션만 고릅니다(같은 세션 ID 는 하나로). 세션마다 대화 기록 끝부분에서 제목·마지막 요청을, `events.jsonl` 에서 계획을 붙여 **바뀐 것이 있을 때만** 한 줄로 내보냅니다. 원격 호스트에는 ssh 로 이 스크립트를 보내 실행하므로 설치가 필요 없습니다.
3. **중계** — `server/app.py` 가 호스트마다 ssh 연결 하나를 유지하며 최신 상태를 모아 두고, 바뀌면 브라우저로 즉시 보냅니다(SSE). 끊기면 다시 붙습니다.
4. **그리기** — 브라우저가 이벤트를 처음부터 재생해 단계·상태·파생·제외를 계산하고, 선행 단계 깊이로 열을, 갈라져 나온 단계는 원점 아래 줄에 배치합니다. 바뀐 노드만 애니메이션으로 갱신합니다.

세션을 끄면(프로세스 종료) 화면에서 사라지고, 기록 파일은 남습니다.

## 요구 사항

| 위치 | 필요한 것 |
|---|---|
| 대시보드를 띄울 컴퓨터 (macOS / Linux / Windows) | Python 3.8 이상, Claude Code, 원격 호스트를 쓸 경우 `ssh` 명령 |
| ssh 로 붙을 서버 (Linux / macOS) | Python 3.6 이상, Claude Code, **비밀번호 입력 없이** 키로 ssh 접속 가능 |
| Windows 추가 사항 | python.org 의 Python (설치 시 "Add python.exe to PATH" 체크), OpenSSH 클라이언트 (설정 › 시스템 › 선택적 기능, 보통 기본 설치됨) |

외부 패키지는 쓰지 않습니다 (표준 라이브러리만).

## 설치

### macOS / Linux
```bash
unzip follow_wollof-*.zip && cd follow_wollof
./fw init                 # config.ini 생성
vi config.ini             # 호스트 입력 (아래 "설정" 참고)
./fw selftest             # (선택) 이 컴퓨터에서 모든 기능 자가 점검 — 실제 설정은 건드리지 않음
./fw check                # 이 컴퓨터 환경 + 호스트별 접속·세션 확인
./fw deploy               # 각 호스트에 세션 쪽 도구 설치
./fw                      # 대시보드 열기
ln -s "$PWD/fw" ~/.local/bin/fw   # (선택) 어디서든 fw 로 실행
./fw autostart on         # (선택) 로그인 시 자동 실행
./fw shortcut on          # (선택) 바로가기 아이콘: ~/Applications 와 Dock (Linux: 앱 메뉴)
```

### Windows (PowerShell)
```powershell
Expand-Archive follow_wollof-*.zip -DestinationPath $HOME\Apps
cd $HOME\Apps\follow_wollof
.\fw.cmd init
notepad config.ini
.\fw.cmd selftest      # (선택) 모든 기능 자가 점검 — 실제 설정은 건드리지 않음
.\fw.cmd check
.\fw.cmd deploy
.\fw.cmd
.\fw.cmd autostart on     # (선택) 로그인 시 자동 실행 (시작프로그램 폴더에 등록)
.\fw.cmd shortcut on      # (선택) 바탕화면과 시작 메뉴에 바로가기 아이콘
```
폴더를 PATH 에 추가하면 어디서든 `fw` 로 실행할 수 있습니다.

바로가기를 누르면 서버를 (필요하면) 켜고 대시보드를 주소창·탭 없는 창으로 엽니다 (`fw window` 와 같음, Chrome 이나 Edge 가 있을 때. 없으면 기본 브라우저 탭). Windows 작업 표시줄에 두려면 바탕화면 아이콘을 오른쪽 클릭 › 작업 표시줄에 고정. 지우기는 `fw shortcut off`, Dock 을 건드리지 않으려면 `fw shortcut on --no-dock`. 폴더를 옮기면 `fw shortcut on` 을 다시 실행하세요 (바로가기에 이 폴더 경로가 들어 있음).

## 설정 (`config.ini`)

`fw init` 이 `config.example.ini` 를 `config.ini` 로 복사합니다. **사용자가 채워야 하는 것은 호스트 목록뿐**이고 나머지는 기본값으로 동작합니다. 다른 위치의 설정 파일을 쓰려면 환경변수 `FW_CONFIG` 에 경로를 지정합니다.

```ini
[dashboard]
port = 7777            ; 대시보드 포트
bind = 127.0.0.1       ; 이 컴퓨터에서만 접속 (권장)

[agent]
interval = 2           ; 변화 확인 주기(초)

[ssh]
options =              ; 모든 ssh 호스트에 덧붙일 옵션 (예: -o ProxyJump=bastion)

[host:local]           ; 대시보드를 띄운 이 컴퓨터
type = local

[host:lab-server]      ; [host:<화면에 보일 이름>]
type = ssh
ssh = lab-server       ; ~/.ssh/config 의 Host 별칭 또는 user@hostname
python = python3       ; (선택) 그 서버의 파이썬 명령
```

| 키 | 필수 | 설명 |
|---|---|---|
| `[host:<이름>]` | ✓ | 호스트 하나. 이름은 대시보드에 그대로 표시 |
| `type` | ✓ | `local` 또는 `ssh` |
| `ssh` | ssh 일 때 ✓ | ssh 대상. `~/.ssh/config` 별칭을 쓰면 포트·점프 호스트·키를 그쪽에서 관리 |
| `python` | | 기본: ssh 는 `python3`, local 은 `fw` 를 실행한 파이썬 |
| `deploy` | | `false` 면 `fw deploy` 대상에서 제외 (기본 `true`) |
| `enabled` | | `false` 면 대시보드에서 잠시 제외 |

### ssh 준비
`~/.ssh/config` (Windows: `C:\Users\<사용자>\.ssh\config`) 예시:
```
Host lab-server
    HostName lab.example.org
    User myname
    Port 22
    IdentityFile ~/.ssh/id_ed25519
    # ProxyJump bastion        # 점프 호스트를 거칠 때
```
`ssh lab-server true` 가 아무것도 묻지 않고 끝나야 합니다. **처음 접속하는 서버는 호스트 키 확인(yes) 을 위해 한 번 직접 접속**해 두세요 (대시보드는 질문에 답할 수 없어 접속을 포기합니다). 키에 암호가 있으면 ssh-agent 에 등록합니다 (Windows: `Get-Service ssh-agent | Set-Service -StartupType Automatic; Start-Service ssh-agent; ssh-add`).

## `fw deploy` 가 각 호스트에서 바꾸는 것

| 경로 | 내용 |
|---|---|
| `~/.follow_wollof/bin/` | `follow.py` (기록 명령), `stop_hook.py` |
| `~/.claude/skills/follow/` | `/follow` 스킬 (그래프 수동 정리) |
| `~/.claude/CLAUDE.md` | 표시된 블록 하나 추가 (`<!-- follow_wollof:start -->` ~ `end`) |
| `~/.claude/settings.json` | Stop 훅 하나 추가 (기존 훅 유지) |

처음 설치할 때 두 파일의 원본을 `*.bak-follow_wollof` 로 백업합니다. 제거는 `fw deploy --uninstall`, 미리보기는 `fw deploy --dry-run`. 파이썬 경로는 호스트마다 자동으로 채워집니다.

## 세션에서 쓰기
- 새 세션: 여러 단계 작업을 시작하면 Claude 가 알아서 계획을 등록하고 단계를 갱신합니다.
- 설치 전부터 열려 있던 세션: `/follow` 입력.
- 직접 기록할 때 (`follow.py help`):

| 명령 | 의미 |
|---|---|
| `follow.py plan "제목" qc:QC deg:DEG gsea:GSEA` | 계획 등록 (기본은 순서대로 연결, `id:제목<a,b` 로 병렬·합류) |
| `follow.py next deg` | 현재 단계 완료 + 다음 단계 시작 |
| `follow.py block deg "이유"` | 막힘 / 입력 대기 |
| `follow.py derive batch "배치 보정" --from deg --into gsea --reason "…"` | 기존 단계에서 갈라져 나온 작업 |
| `follow.py drop gsva --reason "…" --by gsea` | 포기한 단계와 대체 단계 |
| `follow.py replan "이유" id:제목 …` | 전면 재계획 |
| `follow.py topic ncc-rnaseq "단일세포 참조로 비율 추정"` | 이 세션을 주제에 연결 (같은 주제의 세션끼리 온톨로지에서 이어짐, 서버가 달라도 됨) |
| `follow.py topics` | 이 호스트의 세션들이 이미 쓴 주제 목록 |
| `follow.py out deg report/DEG.pdf fig/volcano.png` | 그 단계가 만든 보고서·PPT·PDF·그림을 붙임 (대시보드에서 바로 열기) |
| `follow.py next gsea --out report/DEG.pdf` | 지금 단계를 끝내면서 산출물을 붙임 |

## 대시보드 읽는 법
### 프로젝트 (기본 화면)
`config.ini` 의 `[project:<이름>]` 섹션마다 프로젝트 하나입니다 (아래 "프로젝트 설정"). 어느 컴퓨터에서 돌든 같은 프로젝트의 세션은 한곳에 모이고, 컴퓨터는 세션에 붙은 이름표로만 보입니다.

**세션 온톨로지** (프로젝트를 가운데 둔 마인드맵)
- 프로젝트 → 세션 → 그 세션이 하는 일. 세션은 프로젝트 양옆에 나뉘어 놓이고, 실행 중 · 입력 대기 · 대기 · 종료 순으로, 끝난 세션은 접혀 있습니다 (오른쪽 꺾쇠로 펼치기). 맨 아래 "지난 분석 보고서" 는 `daily_analysis` 보고서 묶음
- 세션이 하는 일은 있는 것 중 첫째: 계획(`follow.py`) 단계 → Claude 의 할 일 목록(TodoWrite·TaskCreate) → 그 세션에서 받은 요청 순서(마지막이 지금 하는 일) → 보고서 폴더의 스크립트. Claude 가 띄운 에이전트는 나란히 덧붙습니다
- 단계는 선후 관계대로 화살표로 이어져 세션에서 바깥쪽으로 흐릅니다. 앞 단계가 끝나야 하는 단계는 그 오른쪽(왼쪽 세션은 왼쪽)에, 같이 돌 수 있는 단계는 같은 칸에 위아래로 놓이고, 세 칸이 차면 다음 줄로 넘어가 이어집니다. 계획은 `follow.py` 의 선행 단계(`<dep`)와 갈라져 나온 단계(`derive`)를, 할 일·요청·스크립트는 적힌 순서를 따릅니다
- 줄: 줄은 들어가는 단계의 상태를 따릅니다. 지금 실행 중인 길은 초록 점선이 흐르고, 입력 대기는 호박색으로 깜박이며, 끝난 것은 실선, 남은 것은 점선. 지금 단계는 돌아가는 고리와 경과 시간
- 캔버스: 빈 곳을 끌거나 두 손가락으로 쓸면 이동, ⌘/Ctrl + 휠이나 트랙패드 벌리기로 확대·축소 (오른쪽 아래 `+ − 맞춤 100% 정렬`, 키보드 `+ − 0`). 상자를 끌어 원하는 곳에 둘 수 있고 세션을 끌면 그 할 일도 같이 움직이며, 놓은 자리에서 겹치는 묶음은 옆으로 비켜납니다. 위치와 확대 비율은 프로젝트마다 이 브라우저에 기억되고 `정렬` 로 되돌림
- 어느 프로젝트 폴더에도 없는 세션은 왼쪽 목록 맨 아래 "그 밖의 세션" 에 모입니다. 실행 중인 세션이 있는 프로젝트는 왼쪽 목록에서 초록(입력 대기는 호박색)으로 깜박입니다
- 세션을 누르면 오른쪽에 **읽은 데이터 → 세션** 계보와 만든 표·그림 수. 데이터는 그 세션 대화에 나온 데이터 폴더 경로(몇 번 읽었는지), 보고서에 적힌 경로, 그것도 없으면 이름으로 추정(점선). 두 번 누르거나 `흐름 크게 보기` 로 데이터 → 단계 → 표·그림 → 판정 흐름 창

**데이터 카탈로그**
- 프로젝트의 데이터 폴더를 종류별로 묶습니다: 유전체(DNA) · 전사체(RNA) · 단백질 · 공간·이미지 · 단일세포 · 임상·메타데이터 · 외부·공개 코호트 · 참조·주석 · 기타 (폴더 이름과 경로로 분류)
- 맨 위에 전체 크기와 종류별 비율 막대. 줄마다 단계(원본/가공/결과물/참조), 주요 형식, 샘플 수 추정, 크기, 마지막 변경, 쓰는 분석 수. 줄을 누르면 파일 형태, 위치(호스트·경로), 이 데이터를 쓴 분석 목록
- 서버에서 15분마다 다시 읽습니다 (`다시 읽기` 로 바로). 연결이 끊긴 호스트는 마지막으로 읽은 내용. 파일이 아주 많은 폴더는 항목마다 4만 개·20초까지만 세고 `+` 를 붙임
- 주소: `?view=proj&p=<프로젝트>` · 데이터 `&d=<데이터>` · 세션·보고서 `&a=<id>`

### 질문·할 일
회의나 공부 중에 생긴 질문과 할 일을 프로젝트별, 그 안에서 테마별로 모아 한 페이지에 보여 줍니다 (아래 "질문·할 일 설정").
- 위 입력창에 생각나는 대로 적거나 회의 메모를 통째로 붙여 넣고 `정리해서 넣기` (`⌘/Ctrl + Enter`). 이 컴퓨터의 Claude Code 가 항목으로 나눠 질문/할 일을 가르고, 프로젝트와 테마(있던 테마면 그대로, 없으면 새로)를 고릅니다. 프로젝트를 모르겠으면 맨 위 "어느 프로젝트인지 모름" 에 놓입니다
- 동그라미를 누르면 완료. 완료한 항목은 완료 시각과 함께 남고, `완료한 것도 보기` 를 켜면 보입니다. 다시 누르면 다시 열림
- 글을 두 번 누르면 고치기, `옮기기` 로 프로젝트·테마·종류 바꾸기와 지우기
- 항목 아래 `관련 있어 보임`: 그 프로젝트의 분석(세션·보고서) 중 낱말이 많이 겹치는 것. `연결` 을 누르면 이어지고, 이어진 분석을 누르면 프로젝트 화면에서 그 분석의 흐름이 열립니다. `×` 는 다시 추천하지 않음
- 프로젝트 폴더의 회의록·코멘트·피드백 메모(`.md`, 180일 이내)를 읽어 남은 할 일과 질문을 가져옵니다 (출처 칩을 누르면 원문). 피드백 트래커(`- ID · 상태 · …` 줄)는 그 상태를 그대로 따릅니다
- 가져온 항목은 그 뒤의 분석 보고서(`daily_analysis`, `History_Archive`)와 서버의 질문 기록에 맞춰 보고, 분명히 처리된 것만 `처리됨 · 날짜 보고서` 근거를 붙여 완료로 돌립니다. 새 보고서가 생기면 다시 보고, `처리된 것 확인` 으로 바로 돌릴 수 있습니다. 잘못 표시됐으면 동그라미로 다시 열기
- 서버의 `claude-daily-log/QUESTIONS.md` 질문 기록은 "질문 기록" 으로 읽기 전용으로 보입니다: 최신 판정, 검정 횟수, 마지막 갱신, 판정이 뒤집힌 질문(⚠)과 30일 넘게 그대로인 질문
- 서버의 `analysis_backlog/backlog.md` 항목은 프로젝트마다 "분석 백로그" 로 읽기 전용으로 같이 보입니다 (완료 처리는 지금처럼 서버 쪽에서)
- 목록은 `[todo] host` 서버의 `~/.follow_wollof/todo.json` 하나에 있어 맥·윈도우 어디서 열어도 같습니다. 그 서버에 연결되지 않으면 마지막으로 읽은 목록을 보여 주고 고칠 수는 없습니다

### 산출물과 정체
- 단계에 붙인 파일은 계획 그래프 노드 오른쪽 위의 문서 배지(개수), 세션 페이지의 `산출물` (단계별, 진행 순서), 온톨로지 속성 창에 같은 아이콘으로 나타납니다. 아이콘의 색 띠가 형식입니다: PDF 빨강, PPT 주황, DOC 파랑, XLS·CSV 초록, WEB 보라, IMG 청록, TXT 회색
- 누르면 뷰어가 열립니다. PDF·이미지·HTML 리포트는 바로 보이고, CSV·TSV 는 표, 텍스트·Markdown 은 원문으로 나옵니다. PPT·Word·Excel 은 브라우저가 그릴 수 없어 `내려받기` 로 기본 프로그램에서 엽니다. ←/→ 로 파일 이동, Esc 로 닫기
- 파일은 그 세션이 도는 서버에서 ssh 로 그때그때 가져옵니다 (80MB까지). `follow.py out` 으로 기록된 경로만 열 수 있고, HTML 리포트는 샌드박스에서 실행돼 대시보드 데이터에 접근하지 못합니다
- 정체: 진행 중인 단계가 있는데 2시간 넘게 기록이 없으면 주황 점선과 `정체 · N시간째 기록 없음` 으로 표시되고, 헤더의 `정체` 칩으로 모아 볼 수 있습니다

### 세션
- 세션별 진행 페이지 주소: `http://localhost:7777/?s=<호스트>/<세션ID>` (온톨로지에서 열면 이 주소로 바뀌므로 북마크·공유 가능). 주제 태그를 누르면 온톨로지의 그 주제로
- 왼쪽: 호스트별 세션 제목 (점 색: 초록 작업 중 · 주황 입력 대기 · 회색 유휴)
- 오른쪽: 계획이 있는 세션마다 그래프 (왼쪽 색 띠 = 호스트). 누르면 크게 보기 + 계획 변경 기록
- 순서 바꾸기: 패널 머리(제목 줄)를 잡고 위아래로 끌기. 바꾼 순서는 이 브라우저에 저장되고, 새로 계획을 등록한 세션은 맨 위에 나타납니다. 헤더의 `자동 정렬` 로 되돌림
- 노드: 회전 표시 = 진행 중, 체크 = 완료, 빨강 = 막힘, 취소선 = 제외, 주황 점선 = 갈라져 나온 단계
- 오른쪽 위 버튼: 시스템 / 라이트 / 다크
- 노드에 마우스를 올리면 단계 이름 전체, 상태, 선행·원점 단계가 카드로 보입니다
- 미리보기: `http://localhost:7777/?demo` — 서버 데이터 없이 가짜 계획이 저절로 진행되는 데모 (`?demo=1500` 으로 단계 간격 ms 지정)

## 프로젝트 설정
```ini
[project:유방암 코호트]            ; 섹션 순서 = 프로젝트 화면 순서
lab-server = /home/me/R_env/01_brca
gpu-box    = /scratch/01_brca, /scratch/brca_extra   ; 한 호스트에 여러 폴더는 쉼표로
local      = C:\work\brca
data       = 00_raw_data, 02_data    ; (선택) 데이터 폴더. 비우면 data · raw_data · 02_data · _cohort 같은 이름을 찾고,
                                     ;  01_xxx 같은 하위 프로젝트 안의 데이터 폴더는 하위 프로젝트 하나로 묶음
```
세션은 계획을 세운 폴더(없으면 Claude 를 시작한 폴더)가 들어 있는 프로젝트에 묶입니다. 바꾼 뒤 `fw restart`.

## 질문·할 일 설정
```ini
[todo]
host        = lab-server   ; 목록을 둘 호스트 ([host:<이름>] 중 하나). 맥·윈도우가 같은 서버를 가리키면 같은 목록
classify    = claude       ; off 면 Claude 없이 줄마다 한 항목, 프로젝트는 직접 고름
model       = haiku        ; 분류·회의록 읽기 모델. 도구·설정·MCP 를 끄고 부르므로 한 번에 약 0.1센트
judge_model = sonnet       ; 처리됐는지 판정할 모델
import      = on           ; off 면 회의록에서 새로 가져오지 않음 (처리됨 확인은 계속)
```
Claude Code 에 로그인돼 있어야 분류됩니다. `claude` 명령은 PATH, `~/.local/bin`, npm 전역 설치, 그리고 Antigravity·VS Code·Cursor 확장에 들어 있는 것 순으로 찾고, 못 찾으면 `claude = <경로>`.
프로젝트 이름(`[project:<이름>]`)이 항목의 프로젝트 키이므로, 여러 데스크탑에서 같은 목록을 쓰려면 프로젝트 이름을 똑같이 둡니다 (호스트 이름은 달라도 됨).

## 데스크탑 알림
대시보드 서버가 세션 상태를 보다가 운영체제 알림을 띄웁니다 (macOS 알림 센터, Windows 토스트 — 누르면 그 세션 페이지, Linux `notify-send`).

| 언제 | `events` 이름 |
|---|---|
| Claude 세션이 닫힘 | `ended` |
| 1분 넘게 작업하다 멈추고 다음 지시를 기다림 | `stopped` |
| 권한 확인이나 답을 기다림 | `waiting` |
| 계획의 단계가 막힘 (`follow.py block`) | `blocked` |
| 진행 중인 단계가 2시간째 기록 없음 | `stale` |

```ini
[notify]
enabled  = true
events   = ended, stopped, waiting, blocked, stale
min_busy = 60     ; stopped 는 이 초 이상 작업한 뒤 멈출 때만
```
`fw notify` 로 시험 알림을 보냅니다. 안 보이면 시스템 설정의 알림에서 허용하세요 (macOS 는 "스크립트 편집기", Windows 는 "follow_wollof" 이름으로 옵니다). 서버를 다시 켠 직후의 상태는 알리지 않습니다.

## 명령 요약

| 명령 | 동작 |
|---|---|
| `fw` | 서버를 (필요하면) 켜고 대시보드 열기 |
| `fw window` | 같은 동작, 대시보드를 프로그램처럼 별도 창으로 (Chrome · Edge 앱 모드) |
| `fw init` | `config.ini` 생성 |
| `fw check` | 이 컴퓨터 환경 + 호스트별 접속·세션 확인 |
| `fw selftest` | 모든 기능 자가 점검 (임시 홈 폴더에서 실행, 실제 설정·원격 서버는 건드리지 않음) |
| `fw deploy [--dry-run] [--uninstall] [호스트…]` | 세션 쪽 도구 설치·제거 |
| `fw start` · `stop` · `restart` · `status` | 서버 제어 |
| `fw notify` | 시험 알림 보내기 |
| `fw autostart on` · `off` | 로그인 시 자동 실행 (macOS launchd · Linux systemd --user · Windows 시작프로그램) |
| `fw shortcut on` · `off` [`--no-dock`] | `fw window` 를 여는 바로가기 아이콘 (macOS `~/Applications` + Dock · Windows 바탕화면 + 시작 메뉴 · Linux 앱 메뉴) |
| `fw pack` | 개인 파일(`config.ini` 등)을 뺀 배포용 zip 생성 (`dist/`) |

서버 로그: `~/.follow_wollof/server.log`

## 개인정보
- 대시보드로 오는 데이터: 세션 이름·작업 폴더·상태, 세션 제목, 마지막 요청 앞 120자 (제목이 없을 때 표시용), 계획 기록. 대화 내용이나 파일은 가져오지 않습니다.
- 서버는 기본적으로 `127.0.0.1` 에만 열리고, `localhost`·`127.0.0.1` 이외의 이름으로 온 요청은 거부합니다 (다른 웹사이트가 DNS rebinding 으로 대시보드 데이터를 읽지 못하게).
- 데이터 현황은 프로젝트 폴더 안의 폴더·파일 이름, 크기, 수정 시각과 `README.md` 첫 줄, `RESULTS_DIGEST.md`·`RESEARCH_FLOW.md`·`backlog.md` 의 목록 줄, 분석 폴더의 `00_WHY.md` 첫 줄과 `REPORT.md` 의 제목·판정 줄·데이터 경로만 읽습니다. 데이터 파일 내용은 읽지 않습니다.
- 실행 중인 세션의 분석 폴더는 대화 기록 끝부분에 나온 `daily_analysis/<날짜>/<이름>` 경로로 찾고, 그 폴더의 파일 이름·크기·시각만 봅니다.
- 질문·할 일에서 `정리해서 넣기` 를 누르면 메모 내용과 프로젝트 이름·테마·데이터 이름·최근 분석 제목이 이 컴퓨터의 Claude Code 로 보내집니다. 회의록 가져오기와 처리됨 확인도 메모 내용, 항목, 보고서 제목·판정 줄을 같은 방식으로 보냅니다 (`classify = off` 면 보내지 않음).
- 화면 글꼴(IBM Plex Sans KR)을 fonts.googleapis.com 에서 받습니다. 세션 데이터는 보내지 않으며, 인터넷이 없으면 시스템 글꼴로 표시됩니다.
- 알림 문구에는 세션 제목과 호스트 이름이 들어갑니다 (운영체제 알림 센터에 남음).
- 패널 순서, 테마, 마지막으로 본 화면, 온톨로지 표시 설정은 브라우저 저장소(localStorage)에만 남습니다.
- 배포 zip (`fw pack`) 은 정해진 파일만 담습니다 (README, 견본 설정, 실행 도구, `agent/ server/ web/ session/ tests/ docs/`). `config.ini` 나 폴더에 둔 메모·로그는 들어가지 않습니다.

## 문제 해결

| 증상 | 확인 |
|---|---|
| 호스트 점이 빨강 | 왼쪽 호스트 옆 오류 문구, `fw check`, `ssh <별칭> true` (처음이면 호스트 키 확인) |
| Windows 에서 처음 설치 후 동작 확인 | `fw.cmd selftest` → 모두 ✓ 인지 확인. ✗ 항목의 문구를 그대로 알려주세요 |
| 세션은 보이는데 그래프가 없음 | 그 세션이 아직 계획을 등록하지 않음 → `/follow` |
| Windows 에서 `python` 실행 시 Microsoft Store 가 열림 | 설정 › 앱 › 고급 앱 설정 › 앱 실행 별칭에서 python 별칭 끄기, python.org 버전 설치 |
| 포트 충돌 | `config.ini` 의 `port` 변경 후 `fw restart` |

## 파일 구성
```
fw, fw.cmd, fw.py        실행 도구 (macOS·Linux / Windows / 본체)
config.example.ini       설정 견본  →  config.ini (개인, 배포 제외)
agent/agent.py           호스트별 감시 스크립트 (ssh stdin 으로 전송)
agent/inventory.py       프로젝트 폴더의 데이터 현황과 분석 흐름 읽기 (같은 방식으로 전송)
agent/todo.py            질문·할 일 목록 읽기·쓰기 (잠금을 걸고 한 파일에)
server/app.py, config.py 대시보드 서버, 설정 로더
server/notify.py         세션 종료·멈춤 등의 데스크탑 알림
web/                     화면 (index.html, graph.js 계획 그래프, projects.js 프로젝트 트리·데이터 카탈로그, todo.js 질문·할 일)
tests/selftest.py        fw selftest 자가 점검
docs/                    스크린샷 (데모 데이터)
app/                     바로가기 아이콘 (macOS .icns · Windows .ico · png)
session/                 fw deploy 로 설치되는 세션 쪽 도구
```
