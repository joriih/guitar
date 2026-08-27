# Codex 없이 Riff Sketchbook 실행하기

Riff Sketchbook은 외부 서버가 없어도 됩니다. 앱 아이콘을 누르면 이 Mac 안에서만
`http://127.0.0.1:43117` 서버를 열고 기본 브라우저를 자동으로 실행합니다. Codex나
Python은 실행에 관여하지 않습니다. 설치기는 실행 코드와 Node를
`~/Library/Application Support/Riff Sketchbook/runtime`에 별도로 보관하므로 원본 Codex
작업 폴더를 열지 않아도 앱이 실행됩니다.

## 평소 실행

1. Finder에서 `응용 프로그램`을 엽니다.
2. `Riff Sketchbook`을 더블클릭합니다.
3. 작은 시작 창에서 `준비됐어요`가 표시되면 웹 화면이 자동으로 열립니다.
4. 끝낼 때 시작 창의 `서버 종료`를 누르거나 Riff Sketchbook 앱을 종료합니다.

앱이 이미 실행 중이면 아이콘을 다시 눌러도 새 서버를 만들지 않고 기존 화면만 엽니다.
주소를 직접 입력해야 할 때는 항상 <http://127.0.0.1:43117>입니다. 친구에게 보여주는
Cloudflare 임시 주소는 로컬 사용에는 필요하지 않습니다.

## 앱 아이콘 다시 만들기

앱 아이콘이나 독립 실행 파일을 다시 만들고 싶다면 원본 프로젝트 폴더의
`Install Riff Sketchbook App.command`를 더블클릭합니다. 설치기는 사용자의
`Applications` 폴더와 Application Support에 있는 자신이 만든 Riff Sketchbook 파일만
안전하게 갱신합니다. 기존 설치에서 만든 녹음·환경 설정·백업은 그대로 보존합니다.

## 열리지 않을 때

- Postgres.app이 Applications 폴더에 있는지 확인합니다.
- 독립 설치가 끝난 뒤에는 원본 프로젝트 폴더를 이동해도 평소 실행에는 영향이 없습니다.
- 시작 창의 한국어 오류를 확인하고 `실행 기록 보기`를 누릅니다.
- 앱 아이콘으로 시작 창이 열리지 않으면
  `~/Library/Application Support/Riff Sketchbook/runtime/Run Riff Sketchbook.command`를
  직접 더블클릭합니다.
- 설치본 자체가 손상됐을 때만 원본 프로젝트의 `Install Riff Sketchbook App.command`를
  다시 실행합니다.

## 데이터와 백업

- 앨범·리프 정보는 이 Mac의 로컬 PostgreSQL에 있습니다.
- 설치 후 녹음 파일은 Application Support의 독립 실행 폴더 안 `storage/audio`에 있습니다.
- 중요한 녹음 뒤에는 `Backup Riff Sketchbook.command`를 더블클릭합니다.
- Codex를 사용할 수 없게 되어도 독립 실행 폴더와 PostgreSQL 데이터는 그대로 남습니다.
  `~/Library/Application Support/Riff Sketchbook`과 Postgres.app을 삭제하지 마세요.
