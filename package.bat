@echo off
rem DeepSeek Desktop one-shot Windows build: locates the deepseek-harness
rem checkout (sibling ..\deepseek-harness or DSH_HARNESS_ROOT), syncs this
rem standalone repo (Deepseek-Workflow) into it as deepseek-desktop\, builds
rem the harness tree and the desktop entry, then packages portable and NSIS
rem builds into dist\. Requires Node and pnpm on PATH.
rem
rem 单次 Windows 打包：定位 harness checkout，把本独立仓库同步为它的
rem deepseek-desktop\，构建整树与桌面入口，然后打包 portable 与 NSIS 安装器。
setlocal
call "%~dp0scripts\harness-env.bat"
if errorlevel 1 (
    pause
    exit /b 1
)
cd /d "%HARNESS_ROOT%\deepseek-desktop"

echo [1/6] Installing dependencies...
call pnpm install || goto :fail

echo [2/6] Building the harness (host lib + web dist)...
call pnpm run build || goto :fail

echo [3/6] Building the desktop entry...
call pnpm --filter @deepseek-ai/dsh-desktop run build || goto :fail

echo [4/6] Generating the app icon...
call node scripts\generate-icon.mjs || goto :fail

echo [5/6] Staging and probing...
call node scripts\build-staging.mjs || goto :fail
call node scripts\probe-staging-boot.mjs || goto :fail

echo [6/6] Packaging...
call pnpm exec electron-builder --project deploy --win || goto :fail
rem The unpacked intermediate and debug yaml are electron-builder's own
rem scratch; deploy\ stays as the staging cache (delete it to force a full
rem restage). Final artifacts are dist\*.exe plus latest.yml/blockmap.
if exist dist\win-unpacked rmdir /s /q dist\win-unpacked 2>nul
if exist dist\builder-debug.yml del /q dist\builder-debug.yml 2>nul

echo.
echo Done: see dist\ under the synced deepseek-desktop\ in the harness.
pause
exit /b 0

:fail
echo.
echo Build failed with exit code %errorlevel%.
pause
exit /b 1
