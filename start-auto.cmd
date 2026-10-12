@echo off
rem Starts everything the TikTok autopilot needs: RoxyBrowser, LUNO (posting) and the dashboard.
rem Double-click it after turning the computer on. Running it twice is safe: anything already
rem running is left alone. The Roxy API token is read from data\roxy-browser.json.
chcp 65001 >nul
title Khoi dong Auto TikTok
set "ROOT=%~dp0"
set "ROXY=D:\roxybrower\RoxyBrowser\RoxyBrowser.exe"
set "FIND=%SystemRoot%\System32\find.exe"
set "WAIT=%SystemRoot%\System32\timeout.exe"
set PYTHONIOENCODING=utf-8

echo [1/4] RoxyBrowser...
tasklist /FI "IMAGENAME eq RoxyBrowser.exe" | "%FIND%" /I "RoxyBrowser.exe" >nul
if errorlevel 1 (
  if exist "%ROXY%" ( start "" "%ROXY%" ) else ( echo    Khong tim thay %ROXY% - hay mo Roxy bang tay )
  echo    Doi Roxy mo API...
  "%WAIT%" /t 20 /nobreak >nul
) else (
  echo    Da chay san
)

echo [2/4] LUNO (dang bai TikTok)...
powershell -NoProfile -Command "exit [int](-not (Test-NetConnection 127.0.0.1 -Port 8756 -InformationLevel Quiet -WarningAction SilentlyContinue))" >nul
if errorlevel 1 (
  start "LUNO - dung tat cua so nay" /min cmd /c "cd /d "%ROOT%third_party\luno-automation\backend" && .venv\Scripts\python.exe server.py >> "%TEMP%\luno.log" 2>&1"
) else (
  echo    Da chay san
)

echo [3/4] Dashboard...
powershell -NoProfile -Command "exit [int](-not (Test-NetConnection 127.0.0.1 -Port 3210 -InformationLevel Quiet -WarningAction SilentlyContinue))" >nul
if errorlevel 1 (
  start "Dashboard - dung tat cua so nay" /min cmd /c "cd /d "%ROOT%" && node server\index.js >> "%TEMP%\dashboard.log" 2>&1"
) else (
  echo    Da chay san
)

echo [4/4] Doi dashboard san sang...
for /L %%i in (1,1,60) do (
  powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3210/api/activity -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul
  if not errorlevel 1 goto ready
  "%WAIT%" /t 2 /nobreak >nul
)
echo    Dashboard chua len sau 2 phut - xem log: %TEMP%\dashboard.log
pause
exit /b 1

:ready
start "" http://127.0.0.1:3210/
echo.
echo Xong! He thong dang chay. Co the dong cua so nay.
echo (Dung tat 2 cua so thu nho "LUNO" va "Dashboard" tren thanh tac vu.)
"%WAIT%" /t 10 >nul
