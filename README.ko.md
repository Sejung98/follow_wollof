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
```
폴더를 PATH 에 추가하면 어디서든 `fw` 로 실행할 수 있습니다.

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
### 온톨로지 (기본 화면)
모든 호스트의 세션을 하나의 그래프로 보여 줍니다.
- 호스트 아래에 프로젝트(폴더 모양)가 나뉩니다. 세션 작업 폴더 경로의 첫 번호 폴더가 프로젝트입니다: `…/R_env/01_ncc/figs` → ncc, `07_agent` → agent. 번호 폴더가 없으면 마지막 폴더 이름
- 지금 작업 중인 세션: 초록 빛이 고리를 따라 돌고, 이름 아래에 현재 단계가 초록으로 표시되며, 호스트→프로젝트→세션 연결선에 초록 점선이 흐릅니다. 입력 대기는 주황 고리가 숨쉬듯 깜박임
- 객체: 네모 = 호스트, 폴더 = 프로젝트, 원 = 세션, 마름모 = 주제. 세션 원의 색은 그 세션이 도는 호스트의 색이고, 바깥 테두리가 진행률입니다
- 연결: 호스트–세션 (어디서 도는지), 세션–주제 (`follow.py topic`), 주황 점선 = 주제는 없지만 계획 제목이 비슷한 세션
- 세션 표시: 초록 물결 = 작업 중, 주황 점 = 입력 대기, 빨강 점 = 막힌 단계, 체크 = 모든 단계 완료, 점선 테두리 = 최근 7일 안에 종료된 세션
- 노드를 누르면 오른쪽에 속성 창: 세션이면 진행 막대·현재 단계·계획 그래프·연결된 세션, 주제면 그 주제를 다루는 세션과 각자의 방향. `진행 페이지 열기` (또는 세션 노드 더블클릭) 로 그 세션의 진행 페이지로
- 마우스를 올리거나 선택하면 이웃만 밝아지고 연결선에 각 세션의 방향이 표시됩니다. 왼쪽 검색창으로 찾기, `표시` 에서 호스트 노드·종료된 세션·비슷한 제목 연결을 끄고 켬
- 끌어서 이동, 휠로 확대, 노드는 끌어서 옮김. 오른쪽 아래 버튼으로 전체 보기

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

## 명령 요약

| 명령 | 동작 |
|---|---|
| `fw` | 서버를 (필요하면) 켜고 대시보드 열기 |
| `fw init` | `config.ini` 생성 |
| `fw check` | 이 컴퓨터 환경 + 호스트별 접속·세션 확인 |
| `fw selftest` | 모든 기능 자가 점검 (임시 홈 폴더에서 실행, 실제 설정·원격 서버는 건드리지 않음) |
| `fw deploy [--dry-run] [--uninstall] [호스트…]` | 세션 쪽 도구 설치·제거 |
| `fw start` · `stop` · `restart` · `status` | 서버 제어 |
| `fw autostart on` · `off` | 로그인 시 자동 실행 (macOS launchd · Linux systemd --user · Windows 시작프로그램) |
| `fw pack` | 개인 파일(`config.ini` 등)을 뺀 배포용 zip 생성 (`dist/`) |

서버 로그: `~/.follow_wollof/server.log`

## 개인정보
- 대시보드로 오는 데이터: 세션 이름·작업 폴더·상태, 세션 제목, 마지막 요청 앞 120자 (제목이 없을 때 표시용), 계획 기록. 대화 내용이나 파일은 가져오지 않습니다.
- 서버는 기본적으로 `127.0.0.1` 에만 열리고, `localhost`·`127.0.0.1` 이외의 이름으로 온 요청은 거부합니다 (다른 웹사이트가 DNS rebinding 으로 대시보드 데이터를 읽지 못하게).
- 화면 글꼴(Pretendard)을 cdn.jsdelivr.net 에서 받습니다. 세션 데이터는 보내지 않으며, 인터넷이 없으면 시스템 글꼴로 표시됩니다.
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
server/app.py, config.py 대시보드 서버, 설정 로더
web/                     화면 (index.html, graph.js 계획 그래프, ontology.js 세션 온톨로지)
tests/selftest.py        fw selftest 자가 점검
docs/                    스크린샷 (데모 데이터)
session/                 fw deploy 로 설치되는 세션 쪽 도구
```
