@echo off
rem Locate the deepseek-harness checkout this desktop runs inside, sync this
rem standalone desktop repo (Deepseek-Workflow) into it as deepseek-desktop\,
rem and ensure the harness workspace includes the member. Leaves HARNESS_ROOT
rem set for the caller (called batch files share the environment).
rem
rem Search order: DSH_HARNESS_ROOT env > sibling ..\deepseek-harness > the
rem parent directory already being a harness (this folder sits inside it).
rem ASCII-only: batch parsing is codepage-sensitive.
setlocal
set "FOUND="
if defined DSH_HARNESS_ROOT if exist "%DSH_HARNESS_ROOT%\pnpm-workspace.yaml" set "FOUND=%DSH_HARNESS_ROOT%"
if not defined FOUND if exist "%~dp0..\..\deepseek-harness\pnpm-workspace.yaml" set "FOUND=%~dp0..\..\deepseek-harness"
if not defined FOUND if exist "%~dp0..\..\pnpm-workspace.yaml" set "FOUND=%~dp0..\.."
if not defined FOUND (
    echo [ERROR] deepseek-harness not found.
    echo   Clone or extract deepseek-harness to the sibling folder ..\deepseek-harness,
    echo   or point the DSH_HARNESS_ROOT environment variable at it, then re-run.
    exit /b 1
)
for %%I in ("%FOUND%") do set "FOUND=%%~fI"

rem Already inside the harness as deepseek-desktop: nothing to sync.
for %%I in ("%~dp0..") do set "SELF=%%~fI"
if /i "%SELF%" == "%FOUND%\deepseek-desktop" (
    endlocal & set "HARNESS_ROOT=%FOUND%"
    exit /b 0
)

rem Sync this repo into the harness as deepseek-desktop\ (the repo wins on
rem conflicts; user-local files such as plugins.json that exist only in the
rem target are preserved because they are absent from the source).
echo [PREP] Syncing this repo into the harness as deepseek-desktop\ ...
robocopy "%~dp0.." "%FOUND%\deepseek-desktop" /E /XD .git node_modules lib dist deploy build .iconcheck deploy-stale-* /XF *.log *.tsbuildinfo /NFL /NDL /NJH /NJS >nul
if errorlevel 8 (
    echo [ERROR] Sync failed with robocopy exit code %errorlevel%
    exit /b 1
)

rem Ensure the harness workspace lists deepseek-desktop as a member.
findstr /C:"- deepseek-desktop" "%FOUND%\pnpm-workspace.yaml" >nul 2>nul
if errorlevel 1 (
    echo [PREP] Adding deepseek-desktop to the harness pnpm-workspace.yaml ...
    (echo(& echo   - deepseek-desktop) >> "%FOUND%\pnpm-workspace.yaml"
)
endlocal & set "HARNESS_ROOT=%FOUND%"
exit /b 0
