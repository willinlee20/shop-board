@echo off
setlocal
title Upload shop-board
cd /d "%~dp0"

echo ==============================================
echo    Upload shop-board to GitHub
echo ==============================================
echo.

where git >nul 2>nul
if errorlevel 1 goto NOGIT

if exist ".git" goto HASREPO

echo First run: connecting this folder to GitHub...
git init
git branch -M main
git remote add origin https://github.com/willinlee20/shop-board.git
echo.

:HASREPO
echo [1/4] Staging files
git add -A
echo.

echo [2/4] Commit
git commit -m "update board"
echo.

echo [3/4] Sync with GitHub
git pull --rebase origin main
echo.

echo [4/4] Push
git push -u origin main
if errorlevel 1 goto FAIL
echo.

echo ==============================================
echo    DONE
echo    Wait about 1 minute, then open:
echo    https://willinlee20.github.io/shop-board/
echo ==============================================
echo.
git status -sb
echo.
pause
exit /b

:NOGIT
echo.
echo [ERROR] git is not installed on this PC.
echo Download Git for Windows: https://git-scm.com/download/win
echo Install it, then run this file again.
echo.
pause
exit /b

:FAIL
echo.
echo [PUSH FAILED] Common causes:
echo.
echo   1. GitHub login not finished. A browser window may have opened -
echo      complete the authorization, then run this file again.
echo   2. The repo willinlee20/shop-board does not exist on GitHub yet.
echo      Create it first at https://github.com/new  (Public)
echo   3. No internet connection.
echo.
echo Scroll up to read the red error text, or screenshot this window.
echo.
pause
exit /b
