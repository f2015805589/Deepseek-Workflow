@echo off
rem DeepSeek Desktop one-click dev bootstrap for the standalone repository
rem (Deepseek-Workflow = this folder). Locates the deepseek-harness checkout
rem (sibling ..\deepseek-harness or DSH_HARNESS_ROOT), syncs this repo into it
rem as deepseek-desktop\, installs dependencies, builds the tree, and launches
rem the desktop. The built-in plugins are injected into the profile resolution
rem at every launch, so no per-machine setup is needed for them. ASCII-only:
rem batch parsing is codepage-sensitive.
setlocal

echo ============================================
echo   DeepSeek Desktop - dev bootstrap
echo ============================================
echo.
echo   This repo is the standalone deepseek-desktop (Deepseek-Workflow).
echo   It runs inside a local deepseek-harness checkout, located via
echo   ..\deepseek-harness or DSH_HARNESS_ROOT, and is synced there as
echo   deepseek-desktop\ before install/build/launch.
echo   NOTE: the harness must include the desktop companion packages
echo   (see README) or pnpm install will fail.
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install Node.js 22.19+ or 24+ first.
    pause
    exit /b 1
)
where pnpm >nul 2>nul
if errorlevel 1 (
    echo [FIRST RUN] Installing pnpm 11.7.0 ...
    call npm install -g pnpm@11.7.0
)

call "%~dp0scripts\harness-env.bat"
if errorlevel 1 (
    pause
    exit /b 1
)
cd /d "%HARNESS_ROOT%"

if not exist node_modules (
    echo [FIRST RUN] Installing project dependencies (this can take a while)...
    call pnpm install
    if errorlevel 1 (
        echo [ERROR] Dependency install failed. Check your network and retry.
        pause
        exit /b 1
    )
) else (
    echo [OK] Dependencies ready
)

echo [BUILD] Building the tree (incremental)...
call pnpm run build
if errorlevel 1 (
    echo [ERROR] Build failed. See the log above.
    pause
    exit /b 1
)

echo.
echo [START] Launching DeepSeek Desktop (Electron window)...
echo [HINT] Closing the window quits; a second launch focuses the window.
echo.
call pnpm --filter @deepseek-ai/dsh-desktop start
pause
