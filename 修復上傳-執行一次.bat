@echo off
setlocal
title Fix upload - shop-board
cd /d "%~dp0"

echo ================================================
echo    ONE-TIME FIX
echo.
echo    This makes GitHub match THIS folder.
echo    The files on your Desktop are the newest,
echo    so they will overwrite what is on GitHub.
echo ================================================
echo.
pause
echo.

echo [1/5] Cancelling the stuck rebase
git rebase --abort
echo.

echo [2/5] Cancelling any stuck merge
git merge --abort
echo.

echo [3/5] Making sure the branch is called main
git branch -M main
echo.

echo [4/5] Staging and committing local files
git add -A
git commit -m "shop-board from Desktop"
echo.

echo [5/5] Force pushing to GitHub
git push --force -u origin main
if errorlevel 1 goto FAIL
echo.

echo ================================================
echo    DONE
echo.
echo    GitHub now matches this folder.
echo    From now on use the normal upload .bat file.
echo.
echo    Next step: on GitHub go to
echo    Settings - Pages - Branch: main / (root) - Save
echo    Then open:
echo    https://willinlee20.github.io/shop-board/
echo ================================================
echo.
git log --oneline -1
git status -sb
echo.
pause
exit /b

:FAIL
echo.
echo [FAILED] Read the red text above and screenshot this window.
echo.
echo If it says "Authentication failed" or a browser opened:
echo    finish the GitHub login, then run this file again.
echo.
pause
exit /b
